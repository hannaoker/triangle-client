//! iroh endpoint lifecycle, admission, accept loop, outbound retry, and
//! message send/receive with verified receipts.

use std::collections::HashSet;
use std::fs::{File, OpenOptions};
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, RwLock};
use std::time::Duration;

use anyhow::{bail, Context, Result};
use iroh::endpoint::presets;
use iroh::{Endpoint, EndpointAddr, EndpointId, RelayMode, RelayUrl, Watcher};
use tokio::sync::{Mutex, Notify};
use tracing::{debug, info, warn};

use crate::identity::DeviceIdentity;
use crate::journal::{
    ConsumeOutcome, EnqueueError, InboundOutcome, InboxItem, Journal, JournalLimits,
    OutboundState, OutboundStatus,
};
use crate::protocol::{
    now_unix_ms, read_envelope, write_envelope, PeerMessage, PeerReceipt, PeerReject,
    WireEnvelope, ALPN, MAX_PAYLOAD_BYTES, REJECT_CONFLICT, REJECT_HASH_MISMATCH,
    REJECT_PAYLOAD_TOO_LARGE, REJECT_QUOTA_EXCEEDED, REJECT_SENDER_MISMATCH,
};
use crate::ENGINE_VERSION;

/// QUIC application close code sent to a peer that is not on the roster.
pub const CLOSE_NOT_MEMBER: u32 = 403;
const LOCK_FILE: &str = "engine.lock";

/// How the engine configures iroh relays.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum RelayPreference {
    /// Use n0 default relays + address lookup (`presets::N0`).
    #[default]
    DefaultRelays,
    /// Direct-only: relays disabled. Suitable for same-host and same-LAN tests;
    /// callers must exchange `EndpointAddr` values that include IP addresses.
    DirectOnly,
    /// Custom relay servers (e.g. self-hosted).
    Custom(Vec<RelayUrl>),
}

/// Bounded retry/expiry policy for outbound messages (plan §7).
#[derive(Clone, Debug)]
pub struct RetryPolicy {
    pub initial_backoff: Duration,
    pub max_backoff: Duration,
    /// Messages not settled within this window become `expired` (default 7 days).
    pub expiry: Duration,
    /// How often the retry loop scans for due messages.
    pub tick: Duration,
    /// Upper bound for one connect/send/receipt attempt.
    pub attempt_timeout: Duration,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self {
            initial_backoff: Duration::from_secs(2),
            max_backoff: Duration::from_secs(10 * 60),
            expiry: Duration::from_secs(7 * 24 * 60 * 60),
            tick: Duration::from_millis(500),
            attempt_timeout: Duration::from_secs(30),
        }
    }
}

impl RetryPolicy {
    /// Exponential backoff after `attempts` failures, capped at `max_backoff`.
    pub fn backoff(&self, attempts: u32) -> Duration {
        let exp = attempts.saturating_sub(1).min(20);
        self.initial_backoff
            .saturating_mul(1u32 << exp)
            .min(self.max_backoff)
    }
}

/// Configuration for starting a [`PeerEngine`].
#[derive(Clone, Debug)]
pub struct EngineConfig {
    pub state_dir: PathBuf,
    pub relay: RelayPreference,
    /// Inbound admission roster. Empty = admit nobody (secure default).
    pub allowed_peers: Vec<EndpointId>,
    /// Max time `start` waits for a home relay before continuing degraded.
    pub online_timeout: Duration,
    pub retry: RetryPolicy,
    pub limits: JournalLimits,
}

impl EngineConfig {
    pub fn new(state_dir: impl Into<PathBuf>) -> Self {
        Self {
            state_dir: state_dir.into(),
            relay: RelayPreference::default(),
            allowed_peers: Vec::new(),
            online_timeout: Duration::from_secs(10),
            retry: RetryPolicy::default(),
            limits: JournalLimits::default(),
        }
    }

    pub fn direct_only(mut self) -> Self {
        self.relay = RelayPreference::DirectOnly;
        self
    }

    pub fn allow_peer(mut self, id: EndpointId) -> Self {
        self.allowed_peers.push(id);
        self
    }
}

/// Why a send did not settle.
#[derive(Debug, thiserror::Error)]
pub enum DeliveryError {
    /// Rejected locally before journaling (bad input, frame too large).
    #[error("invalid: {0}")]
    Invalid(String),
    /// `message_id` already used locally for a different payload/peer.
    #[error("conflict: {0}")]
    Conflict(String),
    #[error("outbox full: {0}")]
    OutboxFull(String),
    /// The message is terminal (`expired` / `refused`); use a new id.
    #[error("terminal: {0}")]
    Terminal(String),
    /// Recipient refused or returned an invalid receipt; recorded `refused`.
    #[error("refused ({code}): {reason}")]
    Refused { code: String, reason: String },
    /// Durably queued; the retry loop will keep trying until expiry.
    #[error("pending retry: {0}")]
    Pending(String),
    #[error("internal: {0}")]
    Internal(String),
}

impl DeliveryError {
    pub fn code(&self) -> &'static str {
        match self {
            DeliveryError::Invalid(_) => "invalid_params",
            DeliveryError::Conflict(_) => "conflict",
            DeliveryError::OutboxFull(_) => "outbox_full",
            DeliveryError::Terminal(_) => "terminal",
            DeliveryError::Refused { .. } => "refused",
            DeliveryError::Pending(_) => "pending",
            DeliveryError::Internal(_) => "internal",
        }
    }
}

fn internal(e: impl std::fmt::Display) -> DeliveryError {
    DeliveryError::Internal(e.to_string())
}

struct EngineInner {
    state_dir: PathBuf,
    identity: DeviceIdentity,
    endpoint: Endpoint,
    journal: Mutex<Journal>,
    inbox_notify: Notify,
    roster: RwLock<HashSet<EndpointId>>,
    retry: RetryPolicy,
    relay_online: Arc<AtomicBool>,
    relay_enabled: bool,
    lock_file: std::sync::Mutex<Option<File>>,
}

/// Running peer connectivity engine.
#[derive(Clone)]
pub struct PeerEngine {
    inner: Arc<EngineInner>,
}

impl PeerEngine {
    /// Lock the state dir, load/create identity, open the journal, bind an
    /// iroh endpoint, and spawn the accept and retry loops.
    pub async fn start(config: EngineConfig) -> Result<Self> {
        let state_dir = config.state_dir;
        std::fs::create_dir_all(&state_dir)?;
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = std::fs::metadata(&state_dir)?.permissions();
            perms.set_mode(0o700);
            std::fs::set_permissions(&state_dir, perms)?;
        }
        let lock_file = acquire_state_lock(&state_dir)?;

        let identity = DeviceIdentity::load_or_create(&state_dir)?;
        let journal = Journal::open_with(&state_dir, config.limits.clone())?;

        let relay_enabled = config.relay != RelayPreference::DirectOnly;
        let mut builder = match &config.relay {
            RelayPreference::DefaultRelays => Endpoint::builder(presets::N0),
            RelayPreference::DirectOnly => {
                Endpoint::builder(presets::N0).relay_mode(RelayMode::Disabled)
            }
            RelayPreference::Custom(urls) => Endpoint::builder(presets::N0)
                .relay_mode(RelayMode::Custom(urls.iter().cloned().collect())),
        };
        builder = builder
            .secret_key(identity.secret_key().clone())
            .alpns(vec![ALPN.to_vec()]);
        let endpoint = builder.bind().await.context("bind iroh endpoint")?;

        let relay_online = Arc::new(AtomicBool::new(false));
        if relay_enabled {
            // Never block startup indefinitely on WAN/relay reachability:
            // iroh's online() has no timeout and waits forever offline.
            let ep = endpoint.clone();
            let flag = relay_online.clone();
            let online = tokio::spawn(async move {
                ep.online().await;
                flag.store(true, Ordering::SeqCst);
            });
            if tokio::time::timeout(config.online_timeout, async {
                while !relay_online.load(Ordering::SeqCst) && !online.is_finished() {
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
            })
            .await
            .is_err()
            {
                warn!(
                    timeout_ms = config.online_timeout.as_millis() as u64,
                    "relay not reachable yet; continuing degraded (direct paths only until online)"
                );
            }
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
                roster: RwLock::new(config.allowed_peers.iter().copied().collect()),
                retry: config.retry,
                relay_online,
                relay_enabled,
                lock_file: std::sync::Mutex::new(Some(lock_file)),
            }),
        };

        let accept_engine = engine.clone();
        tokio::spawn(async move {
            if let Err(err) = accept_engine.accept_loop().await {
                warn!(error = %err, "peer-engine accept loop exited");
            }
        });
        let retry_engine = engine.clone();
        tokio::spawn(async move { retry_engine.retry_loop().await });

        info!(
            endpoint_id = %engine.endpoint_id_hex(),
            version = ENGINE_VERSION,
            relay = ?config.relay,
            roster = config.allowed_peers.len(),
            "peer-engine started"
        );
        Ok(engine)
    }

    pub fn state_dir(&self) -> &Path {
        &self.inner.state_dir
    }

    pub fn endpoint_id(&self) -> EndpointId {
        self.inner.identity.secret_key().public()
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

    pub fn endpoint_addr_json(&self) -> Result<serde_json::Value> {
        Ok(serde_json::to_value(self.endpoint_addr())?)
    }

    /// `None` when relays are disabled.
    pub fn relay_online(&self) -> Option<bool> {
        self.inner
            .relay_enabled
            .then(|| self.inner.relay_online.load(Ordering::SeqCst))
    }

    // ------------------------------------------------------------------ roster

    pub fn allow_peer(&self, id: EndpointId) {
        self.inner.roster.write().expect("roster lock").insert(id);
    }

    pub fn is_member(&self, id: &EndpointId) -> bool {
        self.inner.roster.read().expect("roster lock").contains(id)
    }

    pub fn roster_size(&self) -> usize {
        self.inner.roster.read().expect("roster lock").len()
    }

    // ------------------------------------------------------------------- inbox

    /// All unconsumed inbox items (ordered by `seq`).
    pub async fn inbox(&self) -> Vec<InboxItem> {
        self.inner.journal.lock().await.inbox_items()
    }

    /// Acknowledge an inbox item so it leaves the inbox.
    pub async fn consume(&self, from_endpoint_id: &str, message_id: &str) -> Result<ConsumeOutcome> {
        self.inner.journal.lock().await.consume(from_endpoint_id, message_id)
    }

    pub async fn outbound_status(&self, message_id: &str) -> Option<OutboundStatus> {
        self.inner.journal.lock().await.outbound_status(message_id)
    }

    pub async fn journal_counts(&self) -> (usize, usize, u64) {
        let j = self.inner.journal.lock().await;
        (j.unconsumed_count(), j.queued_count(), j.line_count())
    }

    /// Wait until at least `min_count` inbox items exist (or timeout via caller).
    pub async fn wait_inbox_count(&self, min_count: usize) {
        loop {
            // Register before checking so a notify between check and await is not lost.
            let notified = self.inner.inbox_notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.inbox().await.len() >= min_count {
                return;
            }
            notified.await;
        }
    }

    // -------------------------------------------------------------------- send

    /// Durably enqueue a message for `peer`, then attempt delivery once.
    ///
    /// Returns the verified receipt on success. On a transient failure the
    /// message stays `queued_local` and the retry loop keeps trying with
    /// exponential backoff until `RetryPolicy::expiry` ([`DeliveryError::Pending`]).
    pub async fn send_message(
        &self,
        peer: EndpointAddr,
        message_id: impl Into<String>,
        payload: impl Into<String>,
    ) -> std::result::Result<PeerReceipt, DeliveryError> {
        let message_id = message_id.into();
        let payload = payload.into();
        if message_id.is_empty() {
            return Err(DeliveryError::Invalid("message_id must not be empty".into()));
        }
        let mut message = PeerMessage::new(message_id.clone(), payload.clone(), self.endpoint_id_hex())
            .map_err(|e| DeliveryError::Invalid(e.to_string()))?;
        // Reject unsendable frames BEFORE journaling.
        message
            .check_frame_size()
            .map_err(|e| DeliveryError::Invalid(e.to_string()))?;

        let peer_addr_json = serde_json::to_value(&peer).map_err(internal)?;
        let lease = now_unix_ms() + self.inner.retry.attempt_timeout.as_millis() as u64 * 2;
        {
            let mut journal = self.inner.journal.lock().await;
            match journal
                .enqueue_outbound(&message_id, &payload, &peer.id.to_string(), peer_addr_json, lease)
                .map_err(internal)?
            {
                Ok(_) => {}
                Err(EnqueueError::Conflict(m)) => return Err(DeliveryError::Conflict(m)),
                Err(e @ EnqueueError::Terminal(..)) => return Err(DeliveryError::Terminal(e.to_string())),
                Err(e @ EnqueueError::OutboxFull(_)) => {
                    return Err(DeliveryError::OutboxFull(e.to_string()))
                }
            }
            if let Some(status) = journal.outbound_status(&message_id) {
                message.created_at_unix_ms = status.queued_at_unix_ms;
            }
        }
        self.attempt(peer, message).await
    }

    /// One delivery attempt for an already-journaled message.
    async fn attempt(
        &self,
        peer: EndpointAddr,
        message: PeerMessage,
    ) -> std::result::Result<PeerReceipt, DeliveryError> {
        let message_id = message.message_id.clone();
        let result = tokio::time::timeout(
            self.inner.retry.attempt_timeout,
            self.exchange(peer.clone(), &message),
        )
        .await
        .unwrap_or_else(|_| Err(anyhow::anyhow!("attempt timed out")));

        match result {
            Ok(WireEnvelope::Receipt(receipt)) => {
                if let Err(reason) = verify_receipt(&receipt, &message, &peer.id) {
                    self.inner
                        .journal
                        .lock()
                        .await
                        .record_refused(&message_id, &format!("invalid_receipt: {reason}"))
                        .map_err(internal)?;
                    return Err(DeliveryError::Refused {
                        code: "invalid_receipt".into(),
                        reason,
                    });
                }
                let mut journal = self.inner.journal.lock().await;
                match journal.outbound_state(&message_id) {
                    Some(OutboundState::Queued) => {
                        journal.record_settled(&message_id).map_err(internal)?;
                    }
                    Some(OutboundState::Settled) => {}
                    other => {
                        return Err(DeliveryError::Terminal(format!(
                            "message {message_id} is {other:?}"
                        )))
                    }
                }
                Ok(receipt)
            }
            Ok(WireEnvelope::Reject(reject)) if reject.message_id == message_id => {
                if reject.is_retryable() {
                    self.schedule_retry(&message_id).await;
                    Err(DeliveryError::Pending(format!("{}: {}", reject.code, reject.reason)))
                } else {
                    self.inner
                        .journal
                        .lock()
                        .await
                        .record_refused(&message_id, &format!("{}: {}", reject.code, reject.reason))
                        .map_err(internal)?;
                    Err(DeliveryError::Refused { code: reject.code, reason: reject.reason })
                }
            }
            Ok(other) => {
                self.schedule_retry(&message_id).await;
                Err(DeliveryError::Pending(format!("unexpected reply: {other:?}")))
            }
            Err(err) => {
                self.schedule_retry(&message_id).await;
                Err(DeliveryError::Pending(format!("{err:#}")))
            }
        }
    }

    async fn schedule_retry(&self, message_id: &str) {
        let mut journal = self.inner.journal.lock().await;
        let attempts = journal.attempts(message_id) + 1;
        let next = now_unix_ms() + self.inner.retry.backoff(attempts).as_millis() as u64;
        journal.note_attempt_failed(message_id, next);
    }

    async fn exchange(&self, peer: EndpointAddr, message: &PeerMessage) -> Result<WireEnvelope> {
        let expected = peer.id;
        let conn = self
            .inner
            .endpoint
            .connect(peer, ALPN)
            .await
            .context("connect to peer")?;
        if conn.remote_id() != expected {
            bail!("connected to unexpected endpoint {}", conn.remote_id());
        }
        let (mut send, mut recv) = conn.open_bi().await.context("open bi stream")?;
        write_envelope(&mut send, &WireEnvelope::Message(message.clone())).await?;
        send.finish().context("finish send stream")?;
        let envelope = read_envelope(&mut recv).await;
        conn.close(0u32.into(), b"done");
        envelope
    }

    async fn retry_loop(self) {
        let closed = self.inner.endpoint.closed();
        tokio::pin!(closed);
        loop {
            tokio::select! {
                _ = &mut closed => break,
                _ = tokio::time::sleep(self.inner.retry.tick) => {}
            }
            let now = now_unix_ms();
            let lease = now + self.inner.retry.attempt_timeout.as_millis() as u64 * 2;
            let (expired, due) = {
                let mut j = self.inner.journal.lock().await;
                j.take_due(now, self.inner.retry.expiry, lease)
            };
            for id in expired {
                let mut j = self.inner.journal.lock().await;
                match j.record_expired(&id) {
                    Ok(_) => info!(message_id = %id, "outbound message expired"),
                    Err(err) => warn!(message_id = %id, error = %err, "record expiry failed"),
                }
            }
            for d in due {
                let peer: EndpointAddr = match serde_json::from_value(d.peer_addr) {
                    Ok(a) => a,
                    Err(err) => {
                        warn!(message_id = %d.message_id, error = %err, "bad stored peer_addr");
                        continue;
                    }
                };
                let mut message = match PeerMessage::new(&d.message_id, d.payload, self.endpoint_id_hex()) {
                    Ok(m) => m,
                    Err(_) => continue,
                };
                message.created_at_unix_ms = d.queued_at_unix_ms;
                let engine = self.clone();
                tokio::spawn(async move {
                    match engine.attempt(peer, message).await {
                        Ok(_) => debug!("retry settled"),
                        Err(err) => debug!(error = %err, "retry attempt failed"),
                    }
                });
            }
        }
    }

    /// Gracefully close the endpoint (stops accept + retry loops) and release
    /// the state-dir lock.
    pub async fn shutdown(self) {
        self.inner.endpoint.close().await;
        if let Some(f) = self.inner.lock_file.lock().expect("lock mutex").take() {
            let _ = f.unlock();
        }
    }

    // ----------------------------------------------------------------- inbound

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

    async fn handle_incoming(&self, incoming: iroh::endpoint::Incoming) -> Result<()> {
        let conn = incoming.await.context("accept connection")?;
        let remote_id = conn.remote_id();
        // Admission BEFORE reading any frame. The TLS handshake already proved
        // possession of `remote_id`'s key, so a wrong key == a non-member.
        if !self.is_member(&remote_id) {
            warn!(remote = %remote_id, "rejecting non-member peer");
            conn.close(CLOSE_NOT_MEMBER.into(), b"not_member");
            return Ok(());
        }
        let remote = remote_id.to_string();
        let timeout = self.inner.retry.attempt_timeout;
        let (mut send, mut recv) = tokio::time::timeout(timeout, conn.accept_bi())
            .await
            .context("accept bi timed out")?
            .context("accept bi")?;
        let envelope = tokio::time::timeout(timeout, read_envelope(&mut recv))
            .await
            .context("read message timed out")??;
        let message = match envelope {
            WireEnvelope::Message(m) => m,
            _ => bail!("unexpected envelope on inbound stream"),
        };

        let reply = if message.sender_endpoint_id != remote {
            reject(&message, REJECT_SENDER_MISMATCH, "sender_endpoint_id does not match connection identity")
        } else if message.payload.len() > MAX_PAYLOAD_BYTES {
            reject(&message, REJECT_PAYLOAD_TOO_LARGE, "payload exceeds MAX_PAYLOAD_BYTES")
        } else if message.verify_hash().is_err() {
            reject(&message, REJECT_HASH_MISMATCH, "payload_hash does not match payload")
        } else {
            let outcome = {
                let mut journal = self.inner.journal.lock().await;
                journal.accept_inbound(&remote, &message.message_id, &message.payload)?
            };
            match outcome {
                InboundOutcome::Accepted => {
                    // Durable (fsynced) before notify and before receipt.
                    self.inner.inbox_notify.notify_waiters();
                    WireEnvelope::Receipt(PeerReceipt::for_message(&message, self.endpoint_id_hex(), false))
                }
                InboundOutcome::Duplicate => {
                    WireEnvelope::Receipt(PeerReceipt::for_message(&message, self.endpoint_id_hex(), true))
                }
                InboundOutcome::Conflict => reject(
                    &message,
                    REJECT_CONFLICT,
                    "message_id already accepted from this sender with a different payload",
                ),
                InboundOutcome::QuotaExceeded => reject(
                    &message,
                    REJECT_QUOTA_EXCEEDED,
                    "per-peer unconsumed inbox quota exceeded; retry later",
                ),
            }
        };
        write_envelope(&mut send, &reply).await?;
        send.finish().context("finish reply stream")?;
        let _ = tokio::time::timeout(timeout, conn.closed()).await;
        Ok(())
    }
}

fn reject(message: &PeerMessage, code: &str, reason: &str) -> WireEnvelope {
    WireEnvelope::Reject(PeerReject {
        message_id: message.message_id.clone(),
        code: code.to_string(),
        reason: reason.to_string(),
    })
}

/// A receipt must name our message, our exact payload, and the peer we dialed.
fn verify_receipt(
    receipt: &PeerReceipt,
    message: &PeerMessage,
    peer: &EndpointId,
) -> std::result::Result<(), String> {
    if receipt.message_id != message.message_id {
        return Err(format!("message_id {} != {}", receipt.message_id, message.message_id));
    }
    if receipt.status != "received_peer" {
        return Err(format!("unexpected status {}", receipt.status));
    }
    if receipt.payload_hash != message.payload_hash {
        return Err("payload_hash does not match the sent payload".into());
    }
    if receipt.receiver_endpoint_id != peer.to_string() {
        return Err(format!(
            "receiver_endpoint_id {} != dialed peer {peer}",
            receipt.receiver_endpoint_id
        ));
    }
    Ok(())
}

/// Exclusive advisory lock on `$STATE_DIR/engine.lock` (sole-writer guarantee).
fn acquire_state_lock(state_dir: &Path) -> Result<File> {
    let path = state_dir.join(LOCK_FILE);
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .open(&path)
        .with_context(|| format!("open {}", path.display()))?;
    match file.try_lock() {
        Ok(()) => Ok(file),
        Err(std::fs::TryLockError::WouldBlock) => bail!(
            "another peer-engine already holds {} (refusing to start a second writer)",
            path.display()
        ),
        Err(std::fs::TryLockError::Error(e)) => {
            Err(e).with_context(|| format!("lock {}", path.display()))
        }
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
        match tokio::time::timeout(Duration::from_millis(100), watcher.updated()).await {
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
