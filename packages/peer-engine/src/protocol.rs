//! Message/receipt wire protocol over iroh QUIC streams.
//!
//! Framing: 4-byte big-endian length + UTF-8 JSON body.
//! Stable `message_id` values enable duplicate suppression across retries.

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Application-layer protocol negotiated during the iroh handshake.
pub const ALPN: &[u8] = b"triangle-peer/1";

/// Maximum accepted payload bytes (body, not framed envelope).
pub const MAX_PAYLOAD_BYTES: usize = 256 * 1024;

/// Maximum framed wire message (JSON envelope) we will read.
pub const MAX_FRAME_BYTES: usize = MAX_PAYLOAD_BYTES + 64 * 1024;

/// Peer message envelope (sender → recipient).
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct PeerMessage {
    pub message_id: String,
    pub payload_hash: String,
    /// UTF-8 payload for the M2-start spike (binary can follow later).
    pub payload: String,
    pub sender_endpoint_id: String,
    pub created_at_unix_ms: u64,
}

/// Receipt confirming durable acceptance (`received_peer`).
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct PeerReceipt {
    pub message_id: String,
    pub payload_hash: String,
    /// Always `received_peer` for this protocol version when accepted.
    pub status: String,
    pub receiver_endpoint_id: String,
    pub duplicate: bool,
    pub received_at_unix_ms: u64,
}

/// Explicit refusal: the recipient did **not** accept the message. Never a receipt.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct PeerReject {
    pub message_id: String,
    /// `conflict` (same sender + message_id, different payload; terminal),
    /// `quota_exceeded` (retryable), `sender_mismatch` / `hash_mismatch` /
    /// `payload_too_large` / `invalid_message_id` (terminal).
    pub code: String,
    pub reason: String,
}

impl PeerReject {
    /// Whether the sender should keep the message queued and retry later.
    pub fn is_retryable(&self) -> bool {
        self.code == REJECT_QUOTA_EXCEEDED
    }
}

pub const REJECT_CONFLICT: &str = "conflict";
pub const REJECT_QUOTA_EXCEEDED: &str = "quota_exceeded";
pub const REJECT_SENDER_MISMATCH: &str = "sender_mismatch";
pub const REJECT_HASH_MISMATCH: &str = "hash_mismatch";
pub const REJECT_PAYLOAD_TOO_LARGE: &str = "payload_too_large";
pub const REJECT_INVALID_MESSAGE_ID: &str = "invalid_message_id";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum WireEnvelope {
    Message(PeerMessage),
    Receipt(PeerReceipt),
    Reject(PeerReject),
}

/// Exact framed body length (JSON bytes) this envelope would occupy on the wire.
pub fn encoded_frame_len(envelope: &WireEnvelope) -> Result<usize> {
    Ok(serde_json::to_vec(envelope)?.len())
}

impl PeerMessage {
    pub fn new(
        message_id: impl Into<String>,
        payload: impl Into<String>,
        sender_endpoint_id: impl Into<String>,
    ) -> Result<Self> {
        let payload = payload.into();
        if payload.len() > MAX_PAYLOAD_BYTES {
            bail!(
                "payload exceeds MAX_PAYLOAD_BYTES ({MAX_PAYLOAD_BYTES}): {}",
                payload.len()
            );
        }
        let payload_hash = payload_hash_hex(payload.as_bytes());
        Ok(Self {
            message_id: message_id.into(),
            payload_hash,
            payload,
            sender_endpoint_id: sender_endpoint_id.into(),
            created_at_unix_ms: now_unix_ms(),
        })
    }

    pub fn verify_hash(&self) -> Result<()> {
        let actual = payload_hash_hex(self.payload.as_bytes());
        if actual != self.payload_hash {
            bail!("payload_hash mismatch");
        }
        Ok(())
    }
}

impl PeerReceipt {
    pub fn for_message(
        message: &PeerMessage,
        receiver_endpoint_id: impl Into<String>,
        duplicate: bool,
    ) -> Self {
        Self {
            message_id: message.message_id.clone(),
            payload_hash: message.payload_hash.clone(),
            status: "received_peer".to_string(),
            receiver_endpoint_id: receiver_endpoint_id.into(),
            duplicate,
            received_at_unix_ms: now_unix_ms(),
        }
    }
}

impl PeerMessage {
    /// Validate that this message fits in one wire frame once JSON-encoded.
    /// Call before journaling so an unsendable message is never queued.
    pub fn check_frame_size(&self) -> Result<()> {
        let len = encoded_frame_len(&WireEnvelope::Message(self.clone()))?;
        if len > MAX_FRAME_BYTES {
            bail!(
                "encoded message frame is {len} bytes, exceeds MAX_FRAME_BYTES ({MAX_FRAME_BYTES}); \
                 JSON escaping can expand control characters up to 6x"
            );
        }
        Ok(())
    }
}

pub fn payload_hash_hex(payload: &[u8]) -> String {
    let digest = Sha256::digest(payload);
    hex::encode(digest)
}

pub async fn write_envelope(
    send: &mut iroh::endpoint::SendStream,
    envelope: &WireEnvelope,
) -> Result<()> {
    let body = serde_json::to_vec(envelope)?;
    if body.len() > MAX_FRAME_BYTES {
        bail!("frame too large to send: {}", body.len());
    }
    let len = (body.len() as u32).to_be_bytes();
    send.write_all(&len).await.context("write frame length")?;
    send.write_all(&body).await.context("write frame body")?;
    Ok(())
}

pub async fn read_envelope(recv: &mut iroh::endpoint::RecvStream) -> Result<WireEnvelope> {
    let mut len_buf = [0u8; 4];
    recv.read_exact(&mut len_buf)
        .await
        .context("read frame length")?;
    let len = u32::from_be_bytes(len_buf) as usize;
    if len == 0 || len > MAX_FRAME_BYTES {
        bail!("invalid frame length {len}");
    }
    let mut body = vec![0u8; len];
    recv.read_exact(&mut body)
        .await
        .context("read frame body")?;
    let envelope: WireEnvelope = serde_json::from_slice(&body).context("parse wire envelope")?;
    Ok(envelope)
}

pub(crate) fn now_unix_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
