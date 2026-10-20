//! Versioned local IPC over a private Unix-domain socket.
//!
//! See `docs/IPC_CONTRACT.md` for the broker↔peer-engine merge-point contract.
//!
//! Hard rules from the pivot plan:
//! - Private Unix socket with restrictive directory/socket permissions.
//! - Protocol version negotiation and request size bounds.
//! - No unauthenticated loopback TCP control endpoint.
//! - Never accept MESH bearers or workload keys through this surface.

use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{UnixListener, UnixStream};
use tracing::{debug, info};

use crate::engine::PeerEngine;
use crate::ENGINE_VERSION;

/// IPC protocol version. Bump when request/response shapes change incompatibly.
pub const IPC_PROTOCOL_VERSION: u32 = 1;

/// Maximum accepted request frame size (bytes), including JSON overhead.
pub const MAX_IPC_REQUEST_BYTES: usize = 1024 * 1024;

/// Maximum response frame size. Must exceed the worst-case JSON encoding of one
/// max-size inbox item (256 KiB payload, up to 6x when escaped) plus overhead.
pub const MAX_IPC_RESPONSE_BYTES: usize = 2 * 1024 * 1024;

/// Soft byte budget for one `inbox` page (at least one item is always returned).
pub const INBOX_PAGE_BYTE_BUDGET: usize = 1024 * 1024;
/// Default / maximum `limit` for one `inbox` page.
pub const INBOX_DEFAULT_LIMIT: usize = 50;
pub const INBOX_MAX_LIMIT: usize = 200;
/// Maximum items in one `ack` request.
pub const ACK_MAX_ITEMS: usize = 1000;

const SOCKET_NAME: &str = "peer-engine.sock";

/// Unix IPC server bound to `state_dir/ipc/peer-engine.sock`.
pub struct IpcServer {
    path: PathBuf,
    listener: UnixListener,
    engine: PeerEngine,
}

impl IpcServer {
    /// Bind a private socket under `engine.state_dir()/ipc/`.
    pub async fn bind(engine: PeerEngine) -> Result<Self> {
        let ipc_dir = engine.state_dir().join("ipc");
        std::fs::create_dir_all(&ipc_dir)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = std::fs::metadata(&ipc_dir)?.permissions();
            perms.set_mode(0o700);
            std::fs::set_permissions(&ipc_dir, perms)?;
        }

        let path = ipc_dir.join(SOCKET_NAME);
        remove_stale_socket(&path)?;

        let listener = UnixListener::bind(&path)
            .with_context(|| format!("bind unix socket {}", path.display()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = std::fs::metadata(&path)?.permissions();
            perms.set_mode(0o600);
            std::fs::set_permissions(&path, perms)?;
        }

        info!(socket = %path.display(), version = IPC_PROTOCOL_VERSION, "ipc listening");
        Ok(Self {
            path,
            listener,
            engine,
        })
    }

    pub fn socket_path(&self) -> &Path {
        &self.path
    }

    /// Serve until the engine endpoint closes or this future is dropped.
    pub async fn serve(self) -> Result<()> {
        let engine = self.engine.clone();
        let closed = engine.endpoint().closed();
        tokio::pin!(closed);

        loop {
            tokio::select! {
                _ = &mut closed => {
                    info!("ipc server stopping: endpoint closed");
                    break;
                }
                accepted = self.listener.accept() => {
                    let (stream, _addr) = accepted.context("accept ipc connection")?;
                    let engine = self.engine.clone();
                    tokio::spawn(async move {
                        if let Err(err) = handle_client(stream, engine).await {
                            debug!(error = %err, "ipc client session ended");
                        }
                    });
                }
            }
        }
        Ok(())
    }
}

#[derive(Debug, Deserialize)]
struct IpcRequest {
    protocol_version: u32,
    id: String,
    method: String,
    #[serde(default)]
    params: serde_json::Value,
}

#[derive(Debug, Serialize, Deserialize)]
struct IpcResponse {
    protocol_version: u32,
    id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    result: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    error: Option<IpcErrorBody>,
}

#[derive(Debug, Serialize, Deserialize)]
struct IpcErrorBody {
    code: String,
    message: String,
}

/// Only unlink an existing socket path if it is a socket and nothing answers.
fn remove_stale_socket(path: &Path) -> Result<()> {
    use std::os::unix::fs::FileTypeExt;
    let meta = match std::fs::symlink_metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e).with_context(|| format!("stat {}", path.display())),
    };
    if !meta.file_type().is_socket() {
        bail!("{} exists and is not a socket; refusing to remove it", path.display());
    }
    match std::os::unix::net::UnixStream::connect(path) {
        Ok(_) => bail!(
            "a live peer-engine is already serving {}; refusing to replace it",
            path.display()
        ),
        Err(_) => {
            std::fs::remove_file(path)
                .with_context(|| format!("remove stale socket {}", path.display()))?;
            Ok(())
        }
    }
}

fn is_disconnect(err: &anyhow::Error) -> bool {
    err.chain().any(|c| {
        c.downcast_ref::<std::io::Error>().is_some_and(|e| {
            matches!(
                e.kind(),
                std::io::ErrorKind::UnexpectedEof
                    | std::io::ErrorKind::ConnectionReset
                    | std::io::ErrorKind::BrokenPipe
            )
        })
    })
}

async fn handle_client(mut stream: UnixStream, engine: PeerEngine) -> Result<()> {
    let mut hello_ok = false;
    loop {
        let req_bytes = match read_frame(&mut stream, MAX_IPC_REQUEST_BYTES).await {
            Ok(r) => r,
            Err(err) if is_disconnect(&err) => return Ok(()),
            Err(err) => return Err(err),
        };
        let req: IpcRequest = match serde_json::from_slice(&req_bytes) {
            Ok(r) => r,
            Err(err) => {
                let resp = IpcResponse {
                    protocol_version: IPC_PROTOCOL_VERSION,
                    id: "unknown".into(),
                    result: None,
                    error: Some(IpcErrorBody {
                        code: "invalid_request".into(),
                        message: err.to_string(),
                    }),
                };
                write_frame(&mut stream, &serde_json::to_vec(&resp)?, MAX_IPC_RESPONSE_BYTES).await?;
                continue;
            }
        };

        let resp = dispatch(&engine, &mut hello_ok, req).await;
        let shutdown = resp
            .result
            .as_ref()
            .and_then(|v| v.get("shutdown"))
            .and_then(|v| v.as_bool())
            == Some(true);
        write_frame(&mut stream, &serde_json::to_vec(&resp)?, MAX_IPC_RESPONSE_BYTES).await?;
        if shutdown {
            break;
        }
    }
    Ok(())
}

async fn dispatch(engine: &PeerEngine, hello_ok: &mut bool, req: IpcRequest) -> IpcResponse {
    if req.protocol_version != IPC_PROTOCOL_VERSION {
        return err_resp(
            req.id,
            "protocol_mismatch",
            format!(
                "unsupported protocol_version {}; engine speaks {}",
                req.protocol_version, IPC_PROTOCOL_VERSION
            ),
        );
    }

    // Reject any attempt to inject MESH credentials (explicit confinement).
    if req.params.get("mesh_token").is_some()
        || req.params.get("mesh_bearer").is_some()
        || req.params.get("workload_key").is_some()
        || req.params.get("controller_credential").is_some()
    {
        return err_resp(
            req.id,
            "secrets_confined",
            "peer-engine IPC refuses MESH bearers, controller credentials, and workload keys",
        );
    }

    match req.method.as_str() {
        "hello" => {
            *hello_ok = true;
            ok_resp(
                req.id,
                serde_json::json!({
                    "engine_version": ENGINE_VERSION,
                    "protocol_version": IPC_PROTOCOL_VERSION,
                    "endpoint_id": engine.endpoint_id_hex(),
                    "alpn": String::from_utf8_lossy(crate::protocol::ALPN),
                }),
            )
        }
        method if !*hello_ok => err_resp(
            req.id,
            "hello_required",
            format!("call hello before {method}"),
        ),
        "status" => {
            let (inbox_count, outbox_queued, journal_records) = engine.journal_counts().await;
            ok_resp(
                req.id,
                serde_json::json!({
                    "engine_version": ENGINE_VERSION,
                    "protocol_version": IPC_PROTOCOL_VERSION,
                    "endpoint_id": engine.endpoint_id_hex(),
                    "state_dir": engine.state_dir().display().to_string(),
                    "inbox_count": inbox_count,
                    "outbox_queued": outbox_queued,
                    "journal_records": journal_records,
                    "roster_size": engine.roster_size(),
                    "relay_online": engine.relay_online(),
                    "transport_policy": engine.transport_policy(),
                }),
            )
        }
        "transport_diagnostics" => ok_resp(req.id, serde_json::json!({ "samples": engine.transport_diagnostics() })),
        "endpoint_addr" => match engine.endpoint_addr_json() {
            Ok(addr) => ok_resp(req.id, addr),
            Err(err) => err_resp(req.id, "internal", err.to_string()),
        },
        "inbox" => {
            let after_seq = req.params.get("after_seq").and_then(|v| v.as_u64()).unwrap_or(0);
            let limit = req
                .params
                .get("limit")
                .and_then(|v| v.as_u64())
                .map(|l| (l as usize).clamp(1, INBOX_MAX_LIMIT))
                .unwrap_or(INBOX_DEFAULT_LIMIT);
            let (page, has_more) = engine.inbox_page(after_seq, limit, INBOX_PAGE_BYTE_BUDGET).await;
            let next_after_seq = page.last().map(|i| i.seq).unwrap_or(after_seq);
            ok_resp(
                req.id,
                serde_json::json!({
                    "items": page,
                    "next_after_seq": next_after_seq,
                    "has_more": has_more,
                }),
            )
        }
        "ack" => {
            let Some(items) = req.params.get("items").and_then(|v| v.as_array()) else {
                return err_resp(req.id, "invalid_params", "items array required");
            };
            if items.len() > ACK_MAX_ITEMS {
                return err_resp(req.id, "invalid_params", format!("at most {ACK_MAX_ITEMS} items"));
            }
            // Validate the whole batch before consuming anything.
            let mut parsed = Vec::with_capacity(items.len());
            for it in items {
                let (Some(from), Some(id)) = (
                    it.get("from_endpoint_id").and_then(|v| v.as_str()),
                    it.get("message_id").and_then(|v| v.as_str()),
                ) else {
                    return err_resp(req.id, "invalid_params", "each item needs from_endpoint_id and message_id");
                };
                parsed.push((from, id, it));
            }
            let mut acked = 0u64;
            let mut already = 0u64;
            let mut unknown = Vec::new();
            for (from, id, it) in parsed {
                match engine.consume(from, id).await {
                    Ok(crate::journal::ConsumeOutcome::Acked) => acked += 1,
                    Ok(crate::journal::ConsumeOutcome::AlreadyAcked) => already += 1,
                    Ok(crate::journal::ConsumeOutcome::Unknown) => unknown.push(it.clone()),
                    Err(err) => return err_resp(req.id, "internal", err.to_string()),
                }
            }
            ok_resp(
                req.id,
                serde_json::json!({ "acked": acked, "already_acked": already, "unknown": unknown }),
            )
        }
        "message_status" => {
            let Some(id) = req.params.get("message_id").and_then(|v| v.as_str()) else {
                return err_resp(req.id, "invalid_params", "message_id required");
            };
            match engine.outbound_status(id).await {
                Some(st) => ok_resp(req.id, serde_json::to_value(st).unwrap_or_default()),
                None => err_resp(req.id, "not_found", format!("no outbound message {id}")),
            }
        }
        "send" => {
            let message_id = match req.params.get("message_id").and_then(|v| v.as_str()) {
                Some(s) => s.to_string(),
                None => {
                    return err_resp(req.id, "invalid_params", "message_id required");
                }
            };
            let payload = match req.params.get("payload").and_then(|v| v.as_str()) {
                Some(s) => s.to_string(),
                None => return err_resp(req.id, "invalid_params", "payload required"),
            };
            let peer_addr = match req.params.get("peer_addr") {
                Some(v) => match serde_json::from_value::<iroh::EndpointAddr>(v.clone()) {
                    Ok(a) => a,
                    Err(err) => {
                        return err_resp(req.id, "invalid_params", format!("peer_addr: {err}"));
                    }
                },
                None => return err_resp(req.id, "invalid_params", "peer_addr required"),
            };
            match engine.send_message(peer_addr, message_id, payload).await {
                Ok(receipt) => ok_resp(req.id, serde_json::to_value(receipt).unwrap_or_default()),
                Err(err) => err_resp(req.id, err.code(), err.to_string()),
            }
        }
        "shutdown" => ok_resp(req.id, serde_json::json!({ "shutdown": true })),
        other => err_resp(req.id, "unknown_method", format!("unknown method {other}")),
    }
}

fn ok_resp(id: String, result: serde_json::Value) -> IpcResponse {
    IpcResponse {
        protocol_version: IPC_PROTOCOL_VERSION,
        id,
        result: Some(result),
        error: None,
    }
}

fn err_resp(id: String, code: impl Into<String>, message: impl Into<String>) -> IpcResponse {
    IpcResponse {
        protocol_version: IPC_PROTOCOL_VERSION,
        id,
        result: None,
        error: Some(IpcErrorBody {
            code: code.into(),
            message: message.into(),
        }),
    }
}

async fn read_frame(stream: &mut UnixStream, max: usize) -> Result<Vec<u8>> {
    let mut len_buf = [0u8; 4];
    stream
        .read_exact(&mut len_buf)
        .await
        .context("read ipc length")?;
    let len = u32::from_be_bytes(len_buf) as usize;
    if len == 0 || len > max {
        bail!("ipc frame length {len} out of bounds (max {max})");
    }
    let mut body = vec![0u8; len];
    stream
        .read_exact(&mut body)
        .await
        .context("read ipc body")?;
    Ok(body)
}

async fn write_frame(stream: &mut UnixStream, body: &[u8], max: usize) -> Result<()> {
    if body.len() > max {
        bail!("ipc frame too large: {} (max {max})", body.len());
    }
    let len = (body.len() as u32).to_be_bytes();
    stream.write_all(&len).await?;
    stream.write_all(body).await?;
    stream.flush().await?;
    Ok(())
}

/// Client helper used by tests and documentation examples.
pub struct IpcClient {
    stream: UnixStream,
}

impl IpcClient {
    pub async fn connect(socket_path: impl AsRef<Path>) -> Result<Self> {
        let stream = UnixStream::connect(socket_path.as_ref())
            .await
            .with_context(|| format!("connect {}", socket_path.as_ref().display()))?;
        Ok(Self { stream })
    }

    pub async fn call(
        &mut self,
        method: &str,
        params: serde_json::Value,
    ) -> Result<serde_json::Value> {
        let id = uuid::Uuid::new_v4().to_string();
        let req = serde_json::json!({
            "protocol_version": IPC_PROTOCOL_VERSION,
            "id": id,
            "method": method,
            "params": params,
        });
        write_frame(&mut self.stream, &serde_json::to_vec(&req)?, MAX_IPC_REQUEST_BYTES).await?;
        let body = read_frame(&mut self.stream, MAX_IPC_RESPONSE_BYTES).await?;
        let resp: IpcResponse = serde_json::from_slice(&body)?;
        if let Some(err) = resp.error {
            bail!("{}: {}", err.code, err.message);
        }
        Ok(resp.result.unwrap_or(serde_json::Value::Null))
    }
}
