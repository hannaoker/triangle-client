//! iroh endpoint lifecycle, accept loop, and message send/receive with receipts.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{bail, Context, Result};
use iroh::endpoint::presets;
use iroh::{Endpoint, EndpointAddr, RelayMode, Watcher};
use tokio::sync::{Mutex, Notify};
use tracing::{debug, info, warn};

use crate::identity::DeviceIdentity;
use crate::journal::{InboxItem, Journal};
use crate::protocol::{
    read_envelope, write_envelope, PeerMessage, PeerReceipt, WireEnvelope, ALPN,
};
use crate::ENGINE_VERSION;

/// How the engine configures iroh relays.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum RelayPreference {
    /// Use n0 default relays + address lookup (`presets::N0`).
    #[default]
    DefaultRelays,
    /// Direct-only: no relays / no address lookup dependency for path selection.
    /// Suitable for same-host and same-LAN tests; callers must exchange
    /// `EndpointAddr` values that include IP addresses.
    DirectOnly,
}

/// Configuration for starting a [`PeerEngine`].
#[derive(Clone, Debug)]
pub struct EngineConfig {
    pub state_dir: PathBuf,
    pub relay: RelayPreference,
}

impl EngineConfig {
    pub fn new(state_dir: impl Into<PathBuf>) -> Self {
        Self {
            state_dir: state_dir.into(),
            relay: RelayPreference::default(),
        }
    }

    pub fn direct_only(mut self) -> Self {
        self.relay = RelayPreference::DirectOnly;
        self
    }
}

struct EngineInner {
    state_dir: PathBuf,
    identity: DeviceIdentity,
    endpoint: Endpoint,
    journal: Mutex<Journal>,
    inbox_notify: Notify,
}

/// Running peer connectivity engine.
#[derive(Clone)]
pub struct PeerEngine {
    inner: Arc<EngineInner>,
}

impl PeerEngine {
    /// Load/create identity, bind an iroh endpoint, open the journal, and spawn
    /// the accept loop.
    pub async fn start(config: EngineConfig) -> Result<Self> {
        let state_dir = config.state_dir;
        std::fs::create_dir_all(&state_dir)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = std::fs::metadata(&state_dir)?.permissions();
            perms.set_mode(0o700);
            std::fs::set_permissions(&state_dir, perms)?;
        }

        let identity = DeviceIdentity::load_or_create(&state_dir)?;
        let journal = Journal::open(&state_dir)?;

        let mut builder = match config.relay {
            RelayPreference::DefaultRelays => Endpoint::builder(presets::N0),
            RelayPreference::DirectOnly => Endpoint::builder(presets::N0).relay_mode(RelayMode::Disabled),
        };
        builder = builder
            .secret_key(identity.secret_key().clone())
            .alpns(vec![ALPN.to_vec()]);

        let endpoint = builder
            .bind()
            .await
            .context("bind iroh endpoint")?;

        // For default relays, wait until home relay is connected so internet
        // dialing works. Direct-only skips this (online() would hang forever).
        if config.relay == RelayPreference::DefaultRelays {
            endpoint.online().await;
        } else {
            wait_for_direct_addrs(&endpoint).await?;
        }

        let engine = Self {
            inner: Arc::new(EngineInner {
                state_dir,
                identity,
                endpoint: endpoint.clone(),
                journal: Mutex::new(journal),
                inbox_notify: Notify::new(),
            }),
        };

        let accept_engine = engine.clone();
        tokio::spawn(async move {
            if let Err(err) = accept_engine.accept_loop().await {
                warn!(error = %err, "peer-engine accept loop exited");
            }
        });

        info!(
            endpoint_id = %engine.endpoint_id_hex(),
            version = ENGINE_VERSION,
            relay = ?config.relay,
            "peer-engine started"
        );
        Ok(engine)
    }

    pub fn state_dir(&self) -> &Path {
        &self.inner.state_dir
    }

    pub fn endpoint_id_hex(&self) -> String {
        self.inner.identity.endpoint_id_hex()
    }

    pub fn endpoint(&self) -> &Endpoint {
        &self.inner.endpoint
    }

    /// Current dialable address (id + known IPs / relay).
    pub fn endpoint_addr(&self) -> EndpointAddr {
        self.inner.endpoint.addr()
    }

    /// Serialize endpoint address for IPC / tickets.
    pub fn endpoint_addr_json(&self) -> Result<serde_json::Value> {
        Ok(serde_json::to_value(self.endpoint_addr())?)
    }

    pub async fn inbox(&self) -> Vec<InboxItem> {
        self.inner.journal.lock().await.inbox_items()
    }

    /// Wait until at least `min_count` inbox items exist (or timeout via caller).
    pub async fn wait_inbox_count(&self, min_count: usize) {
        loop {
            if self.inbox().await.len() >= min_count {
                return;
            }
            self.inner.inbox_notify.notified().await;
        }
    }

    /// Send a message to `peer` and wait for a durable receipt.
    pub async fn send_message(
        &self,
        peer: EndpointAddr,
        message_id: impl Into<String>,
        payload: impl Into<String>,
    ) -> Result<PeerReceipt> {
        let message_id = message_id.into();
        let payload = payload.into();
        let message = PeerMessage::new(
            message_id.clone(),
            payload.clone(),
            self.endpoint_id_hex(),
        )?;

        {
            let mut journal = self.inner.journal.lock().await;
            journal.append_queued_local(
                &message_id,
                payload.as_bytes(),
                &peer.id.to_string(),
            )?;
        }

        let conn = self
            .inner
            .endpoint
            .connect(peer, ALPN)
            .await
            .context("connect to peer")?;
        let (mut send, mut recv) = conn.open_bi().await.context("open bi stream")?;
        write_envelope(&mut send, &WireEnvelope::Message(message)).await?;
        send.finish().context("finish send stream")?;

        let envelope = read_envelope(&mut recv).await?;
        let receipt = match envelope {
            WireEnvelope::Receipt(r) => r,
            WireEnvelope::Message(_) => bail!("expected receipt, got message"),
        };
        if receipt.message_id != message_id {
            bail!(
                "receipt message_id mismatch: {} vs {}",
                receipt.message_id,
                message_id
            );
        }
        if receipt.status != "received_peer" {
            bail!("unexpected receipt status {}", receipt.status);
        }

        {
            let mut journal = self.inner.journal.lock().await;
            journal.append_settled(&message_id, &receipt.payload_hash)?;
        }

        conn.close(0u32.into(), b"done");
        Ok(receipt)
    }

    /// Gracefully close the endpoint (stops accept loop).
    pub async fn shutdown(self) {
        self.inner.endpoint.close().await;
    }

    async fn accept_loop(self) -> Result<()> {
        let endpoint = self.inner.endpoint.clone();
        while let Some(incoming) = endpoint.accept().await {
            let engine = self.clone();
            tokio::spawn(async move {
                if let Err(err) = engine.handle_incoming(incoming).await {
                    debug!(error = %err, "incoming connection handler failed");
                }
            });
        }
        Ok(())
    }

    async fn handle_incoming(
        &self,
        incoming: iroh::endpoint::Incoming,
    ) -> Result<()> {
        let conn = incoming.await.context("accept connection")?;
        let remote = conn.remote_id().to_string();
        let (mut send, mut recv) = conn.accept_bi().await.context("accept bi")?;
        let envelope = read_envelope(&mut recv).await?;
        let message = match envelope {
            WireEnvelope::Message(m) => m,
            WireEnvelope::Receipt(_) => bail!("unexpected receipt on inbound stream"),
        };
        message.verify_hash()?;
        if message.payload.len() > crate::protocol::MAX_PAYLOAD_BYTES {
            bail!("payload too large");
        }

        let duplicate = {
            let mut journal = self.inner.journal.lock().await;
            let (_entry, duplicate) = journal.append_received_peer(
                &message.message_id,
                message.payload.as_bytes(),
                &remote,
            )?;
            duplicate
        };
        // Durable before notify (plan: append, durable before notify).
        self.inner.inbox_notify.notify_waiters();

        let receipt =
            PeerReceipt::for_message(&message, self.endpoint_id_hex(), duplicate);
        write_envelope(&mut send, &WireEnvelope::Receipt(receipt)).await?;
        send.finish().context("finish receipt stream")?;
        conn.closed().await;
        Ok(())
    }
}

async fn wait_for_direct_addrs(endpoint: &Endpoint) -> Result<()> {
    // Prefer bound sockets immediately; fall back to watching addr updates.
    if !endpoint.bound_sockets().is_empty() || endpoint.addr().ip_addrs().next().is_some() {
        return Ok(());
    }
    let mut watcher = endpoint.watch_addr();
    for _ in 0..50 {
        let addr = Watcher::get(&mut watcher);
        if addr.ip_addrs().next().is_some() {
            return Ok(());
        }
        match tokio::time::timeout(std::time::Duration::from_millis(100), watcher.updated()).await
        {
            Ok(Ok(_)) => continue,
            Ok(Err(_)) => break,
            Err(_) => continue,
        }
    }
    if endpoint.bound_sockets().is_empty() && endpoint.addr().ip_addrs().next().is_none() {
        bail!("endpoint has no direct addresses after bind");
    }
    Ok(())
}
