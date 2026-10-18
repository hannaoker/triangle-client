//! Append-only peer journal with durable writes before notify.
//!
//! The engine is the sole writer (enforced by the state-dir lock in
//! [`crate::engine::PeerEngine::start`]). Entries are JSONL; each append is
//! written as one record + newline, flushed and `fsync`ed before the caller may
//! notify local consumers or emit a receipt.
//!
//! Two independent namespaces:
//! - **outbound**: keyed by local `message_id` (we chose it, so it is unique
//!   within this device). Same id + same payload + same peer is an idempotent
//!   resend; anything else is a local conflict.
//! - **inbound**: keyed by `(sender_endpoint_id, message_id)`. Same key + same
//!   payload hash is a duplicate (receipt with `duplicate: true`); same key with
//!   a different hash is a conflict and is never acknowledged.
//!
//! Size bound: unconsumed inbound items are capped per peer (see
//! [`JournalLimits`]); queued outbound items are capped by `max_outbox`;
//! terminal outbound records and consumed inbound tombstones are dropped by
//! compaction after `tombstone_retention`. Compaction runs on open and every
//! `compact_every_lines` appends, rewriting the file atomically (tmp + fsync +
//! rename + dir fsync) with original `seq` values preserved.

use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, BufWriter, Seek, SeekFrom, Write};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use tracing::warn;

use crate::protocol::{now_unix_ms, payload_hash_hex};

/// Product-aligned delivery states from the pivot plan §7 (peer subset).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeliveryState {
    /// Outbound: persisted before network send.
    QueuedLocal,
    /// Inbound: durably accepted from a peer.
    ReceivedPeer,
    /// Outbound: a matching receipt was verified.
    Settled,
    /// Inbound: identical redelivery; inbox unchanged.
    DuplicateSuppressed,
    /// Outbound: the recipient explicitly refused (terminal).
    Refused,
    /// Outbound: retry window elapsed without a receipt (terminal).
    Expired,
    /// Inbound: a local consumer acknowledged the item (removed from inbox).
    Consumed,
    /// Outbound: refreshed dialable address for a still-queued message.
    AddressUpdated,
    /// Compaction marker preserving the `seq` high-water mark (inbox cursors
    /// stay monotonic even when every older record has been compacted away).
    Checkpoint,
}

/// One durable journal record.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct JournalEntry {
    pub seq: u64,
    pub state: DeliveryState,
    pub message_id: String,
    pub payload_hash: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub payload_hex: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub peer_endpoint_id: Option<String>,
    /// Outbound only: dialable iroh `EndpointAddr` for retries.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub peer_addr: Option<serde_json::Value>,
    /// Outbound only: original enqueue time (preserved across compaction).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub queued_at_unix_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub ts_unix_ms: u64,
}

/// Bounds that keep the journal and its in-memory index finite.
#[derive(Clone, Debug)]
pub struct JournalLimits {
    pub max_unconsumed_per_peer: usize,
    pub max_unconsumed_bytes_per_peer: u64,
    pub max_outbox: usize,
    pub max_outbox_bytes: u64,
    pub tombstone_retention: Duration,
    pub compact_every_lines: u64,
}

impl Default for JournalLimits {
    fn default() -> Self {
        Self {
            max_unconsumed_per_peer: 1000,
            max_unconsumed_bytes_per_peer: 16 * 1024 * 1024,
            max_outbox: 1000,
            max_outbox_bytes: 64 * 1024 * 1024,
            tombstone_retention: Duration::from_secs(7 * 24 * 60 * 60),
            compact_every_lines: 10_000,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum OutboundState {
    Queued,
    Settled,
    Refused,
    Expired,
}

#[derive(Clone, Debug)]
struct OutboundRecord {
    seq: u64,
    state: OutboundState,
    payload_hash: String,
    payload: Option<String>,
    peer_endpoint_id: String,
    peer_addr: Option<serde_json::Value>,
    queued_at_unix_ms: u64,
    last_ts_unix_ms: u64,
    reason: Option<String>,
    // in-memory retry bookkeeping (resets on restart; expiry uses queued_at)
    attempts: u32,
    next_attempt_unix_ms: u64,
}

#[derive(Clone, Debug)]
struct InboundRecord {
    seq: u64,
    payload_hash: String,
    payload: Option<String>,
    ts_unix_ms: u64,
    consumed: bool,
}

/// A received, not-yet-consumed message.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct InboxItem {
    pub seq: u64,
    pub message_id: String,
    pub payload_hash: String,
    pub payload: String,
    pub from_endpoint_id: String,
    pub ts_unix_ms: u64,
}

/// Result of [`Journal::enqueue_outbound`].
#[derive(Debug, PartialEq, Eq)]
pub enum EnqueueOutcome {
    New,
    /// Idempotent re-send of an existing queued/settled message.
    Existing(OutboundState),
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum EnqueueError {
    #[error("message_id {0} already used for a different payload or peer")]
    Conflict(String),
    #[error("message_id {0} is terminal ({1:?}); use a new message_id")]
    Terminal(String, OutboundState),
    #[error("outbox full ({0})")]
    OutboxFull(String),
}

/// Result of [`Journal::accept_inbound`].
#[derive(Debug, PartialEq, Eq)]
pub enum InboundOutcome {
    Accepted,
    Duplicate,
    Conflict,
    QuotaExceeded,
}

/// Result of [`Journal::consume`].
#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ConsumeOutcome {
    Acked,
    AlreadyAcked,
    Unknown,
}

/// Snapshot of an outbound message due for a (re)try.
#[derive(Clone, Debug)]
pub struct DueOutbound {
    pub message_id: String,
    pub payload: String,
    pub peer_addr: serde_json::Value,
    pub queued_at_unix_ms: u64,
}

/// Public view of an outbound message.
#[derive(Clone, Debug, Serialize)]
pub struct OutboundStatus {
    pub message_id: String,
    pub state: String,
    pub peer_endpoint_id: String,
    pub payload_hash: String,
    pub queued_at_unix_ms: u64,
    pub attempts: u32,
    pub next_attempt_unix_ms: Option<u64>,
    pub reason: Option<String>,
}

/// In-memory index over an append-only journal file.
pub struct Journal {
    path: PathBuf,
    limits: JournalLimits,
    next_seq: u64,
    lines: u64,
    lines_since_compact: u64,
    outbound: HashMap<String, OutboundRecord>,
    inbound: HashMap<(String, String), InboundRecord>,
    /// Set by [`Journal::close`]; every later write fails.
    closed: bool,
    /// Live (unconsumed) inbound totals per sender: (count, payload bytes).
    live_inbound: HashMap<String, (usize, u64)>,
}

/// Maximum `message_id` length (bytes) accepted on either side.
pub const MAX_MESSAGE_ID_BYTES: usize = 256;

impl Journal {
    /// Open or create `state_dir/journal/peer.jsonl` with default limits.
    pub fn open(state_dir: impl AsRef<Path>) -> Result<Self> {
        Self::open_with(state_dir, JournalLimits::default())
    }

    /// Open or create the journal. A bad **final** record (torn write) is
    /// truncated; a bad record anywhere else is a hard error.
    pub fn open_with(state_dir: impl AsRef<Path>, limits: JournalLimits) -> Result<Self> {
        let journal_dir = state_dir.as_ref().join("journal");
        if !journal_dir.exists() {
            std::fs::create_dir_all(&journal_dir)?;
            // Make the new journal/ entry durable in the state dir.
            sync_dir(state_dir.as_ref())?;
        }
        let mut dir_perms = std::fs::metadata(&journal_dir)?.permissions();
        dir_perms.set_mode(0o700);
        std::fs::set_permissions(&journal_dir, dir_perms)?;

        let path = journal_dir.join("peer.jsonl");
        let mut journal = Self {
            path: path.clone(),
            limits,
            next_seq: 1,
            lines: 0,
            lines_since_compact: 0,
            outbound: HashMap::new(),
            inbound: HashMap::new(),
            closed: false,
            live_inbound: HashMap::new(),
        };

        if path.exists() {
            let mode = std::fs::metadata(&path)?.permissions().mode() & 0o777;
            if mode & 0o077 != 0 {
                bail!(
                    "refusing journal {}: mode {:04o} allows group/other (need 0600)",
                    path.display(),
                    mode
                );
            }
            // Replay incrementally: only the index is retained in memory.
            let mut lines = 0u64;
            let mut next_seq = 1u64;
            read_entries_recovering_tail(&path, |entry| {
                lines += 1;
                next_seq = next_seq.max(entry.seq.saturating_add(1));
                journal.apply(&entry);
            })?;
            journal.lines = lines;
            journal.next_seq = next_seq;
            journal.compact()?;
        } else {
            let file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&path)?;
            file.sync_all()?;
            drop(file);
            let mut perms = std::fs::metadata(&path)?.permissions();
            perms.set_mode(0o600);
            std::fs::set_permissions(&path, perms)?;
            sync_dir(&journal_dir)?;
        }
        Ok(journal)
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Permanently stop writes (used by engine shutdown before releasing the
    /// state-dir lock, so a surviving clone can never append).
    pub fn close(&mut self) {
        self.closed = true;
    }

    pub fn is_closed(&self) -> bool {
        self.closed
    }

    pub fn limits(&self) -> &JournalLimits {
        &self.limits
    }

    /// Number of physical records currently in the journal file.
    pub fn line_count(&self) -> u64 {
        self.lines
    }

    fn apply(&mut self, e: &JournalEntry) {
        let payload = || {
            e.payload_hex
                .as_ref()
                .and_then(|h| hex::decode(h).ok())
                .and_then(|b| String::from_utf8(b).ok())
        };
        match e.state {
            DeliveryState::QueuedLocal => {
                let Some(peer) = e.peer_endpoint_id.clone() else { return };
                self.outbound.insert(
                    e.message_id.clone(),
                    OutboundRecord {
                        seq: e.seq,
                        state: OutboundState::Queued,
                        payload_hash: e.payload_hash.clone(),
                        payload: payload(),
                        peer_endpoint_id: peer,
                        peer_addr: e.peer_addr.clone(),
                        queued_at_unix_ms: e.queued_at_unix_ms.unwrap_or(e.ts_unix_ms),
                        last_ts_unix_ms: e.ts_unix_ms,
                        reason: None,
                        attempts: 0,
                        next_attempt_unix_ms: 0,
                    },
                );
            }
            DeliveryState::Settled | DeliveryState::Refused | DeliveryState::Expired => {
                let state = match e.state {
                    DeliveryState::Settled => OutboundState::Settled,
                    DeliveryState::Refused => OutboundState::Refused,
                    _ => OutboundState::Expired,
                };
                match self.outbound.get_mut(&e.message_id) {
                    Some(rec) => {
                        rec.state = state;
                        rec.seq = e.seq;
                        rec.last_ts_unix_ms = e.ts_unix_ms;
                        rec.reason = e.reason.clone();
                        rec.payload = None;
                    }
                    None => {
                        // Tombstone (post-compaction or legacy entry).
                        self.outbound.insert(
                            e.message_id.clone(),
                            OutboundRecord {
                                seq: e.seq,
                                state,
                                payload_hash: e.payload_hash.clone(),
                                payload: None,
                                peer_endpoint_id: e.peer_endpoint_id.clone().unwrap_or_default(),
                                peer_addr: None,
                                queued_at_unix_ms: e.queued_at_unix_ms.unwrap_or(e.ts_unix_ms),
                                last_ts_unix_ms: e.ts_unix_ms,
                                reason: e.reason.clone(),
                                attempts: 0,
                                next_attempt_unix_ms: 0,
                            },
                        );
                    }
                }
            }
            DeliveryState::ReceivedPeer => {
                let Some(from) = e.peer_endpoint_id.clone() else { return };
                let body = payload();
                let bytes = body.as_ref().map(|p| p.len() as u64).unwrap_or(0);
                let prev = self.inbound.insert(
                    (from.clone(), e.message_id.clone()),
                    InboundRecord {
                        seq: e.seq,
                        payload_hash: e.payload_hash.clone(),
                        payload: body,
                        ts_unix_ms: e.ts_unix_ms,
                        consumed: false,
                    },
                );
                if let Some(prev) = prev.filter(|p| !p.consumed) {
                    self.live_sub(&from, prev.payload.as_ref().map(|p| p.len() as u64).unwrap_or(0));
                }
                let t = self.live_inbound.entry(from).or_default();
                t.0 += 1;
                t.1 += bytes;
            }
            DeliveryState::Consumed => {
                let Some(from) = e.peer_endpoint_id.clone() else { return };
                if let Some(prev) = self
                    .inbound
                    .get(&(from.clone(), e.message_id.clone()))
                    .filter(|p| !p.consumed)
                {
                    let bytes = prev.payload.as_ref().map(|p| p.len() as u64).unwrap_or(0);
                    self.live_sub(&from, bytes);
                }
                let rec = self
                    .inbound
                    .entry((from, e.message_id.clone()))
                    .or_insert_with(|| InboundRecord {
                        seq: e.seq,
                        payload_hash: e.payload_hash.clone(),
                        payload: None,
                        ts_unix_ms: e.ts_unix_ms,
                        consumed: true,
                    });
                rec.consumed = true;
                rec.payload = None;
                rec.ts_unix_ms = e.ts_unix_ms;
            }
            DeliveryState::AddressUpdated => {
                if let Some(rec) = self.outbound.get_mut(&e.message_id) {
                    if rec.state == OutboundState::Queued && e.peer_addr.is_some() {
                        rec.peer_addr = e.peer_addr.clone();
                    }
                }
            }
            DeliveryState::DuplicateSuppressed | DeliveryState::Checkpoint => {}
        }
    }

    fn live_sub(&mut self, from: &str, bytes: u64) {
        if let Some(t) = self.live_inbound.get_mut(from) {
            t.0 = t.0.saturating_sub(1);
            t.1 = t.1.saturating_sub(bytes);
            if t.0 == 0 {
                self.live_inbound.remove(from);
            }
        }
    }

    // ---------------------------------------------------------------- outbound

    /// Persist an outbound enqueue before network send (idempotent for the
    /// same id + payload + peer).
    pub fn enqueue_outbound(
        &mut self,
        message_id: &str,
        payload: &str,
        peer_endpoint_id: &str,
        peer_addr: serde_json::Value,
        lease_until_unix_ms: u64,
    ) -> Result<std::result::Result<EnqueueOutcome, EnqueueError>> {
        let hash = payload_hash_hex(payload.as_bytes());
        if let Some(rec) = self.outbound.get_mut(message_id) {
            if rec.payload_hash != hash || rec.peer_endpoint_id != peer_endpoint_id {
                return Ok(Err(EnqueueError::Conflict(message_id.to_string())));
            }
            match rec.state {
                OutboundState::Refused | OutboundState::Expired => {
                    return Ok(Err(EnqueueError::Terminal(
                        message_id.to_string(),
                        rec.state.clone(),
                    )));
                }
                OutboundState::Queued => {
                    rec.next_attempt_unix_ms = lease_until_unix_ms;
                    if rec.payload.is_none() {
                        rec.payload = Some(payload.to_string());
                    }
                    if rec.peer_addr.as_ref() != Some(&peer_addr) {
                        // Persist the refreshed address so retries after a
                        // restart dial the new one.
                        let mut entry =
                            self.make_entry(DeliveryState::AddressUpdated, message_id, &hash);
                        entry.peer_endpoint_id = Some(peer_endpoint_id.to_string());
                        entry.peer_addr = Some(peer_addr);
                        let entry = self.append_durable(entry)?;
                        self.apply(&entry);
                    }
                    return Ok(Ok(EnqueueOutcome::Existing(OutboundState::Queued)));
                }
                OutboundState::Settled => {}
            }
            return Ok(Ok(EnqueueOutcome::Existing(OutboundState::Settled)));
        }
        let (queued, queued_bytes) = self.queued_totals();
        if queued >= self.limits.max_outbox {
            return Ok(Err(EnqueueError::OutboxFull(format!("{queued} queued messages"))));
        }
        if queued_bytes + payload.len() as u64 > self.limits.max_outbox_bytes {
            return Ok(Err(EnqueueError::OutboxFull(format!("{queued_bytes} queued payload bytes"))));
        }
        let now = now_unix_ms();
        let mut entry = self.make_entry(DeliveryState::QueuedLocal, message_id, &hash);
        entry.payload_hex = Some(hex::encode(payload.as_bytes()));
        entry.peer_endpoint_id = Some(peer_endpoint_id.to_string());
        entry.peer_addr = Some(peer_addr);
        entry.queued_at_unix_ms = Some(now);
        let entry = self.append_durable(entry)?;
        self.apply(&entry);
        if let Some(rec) = self.outbound.get_mut(message_id) {
            rec.next_attempt_unix_ms = lease_until_unix_ms;
        }
        Ok(Ok(EnqueueOutcome::New))
    }

    pub fn outbound_state(&self, message_id: &str) -> Option<OutboundState> {
        self.outbound.get(message_id).map(|r| r.state.clone())
    }

    pub fn outbound_status(&self, message_id: &str) -> Option<OutboundStatus> {
        self.outbound.get(message_id).map(|r| OutboundStatus {
            message_id: message_id.to_string(),
            state: match r.state {
                OutboundState::Queued => "queued_local",
                OutboundState::Settled => "settled",
                OutboundState::Refused => "refused",
                OutboundState::Expired => "expired",
            }
            .to_string(),
            peer_endpoint_id: r.peer_endpoint_id.clone(),
            payload_hash: r.payload_hash.clone(),
            queued_at_unix_ms: r.queued_at_unix_ms,
            attempts: r.attempts,
            next_attempt_unix_ms: (r.state == OutboundState::Queued)
                .then_some(r.next_attempt_unix_ms),
            reason: r.reason.clone(),
        })
    }

    pub fn queued_count(&self) -> usize {
        self.queued_totals().0
    }

    fn queued_totals(&self) -> (usize, u64) {
        self.outbound
            .values()
            .filter(|r| r.state == OutboundState::Queued)
            .fold((0, 0), |(c, b), r| {
                (c + 1, b + r.payload.as_ref().map(|p| p.len() as u64).unwrap_or(0))
            })
    }

    fn finish_outbound(
        &mut self,
        message_id: &str,
        state: DeliveryState,
        reason: Option<String>,
    ) -> Result<bool> {
        let Some(rec) = self.outbound.get(message_id) else { return Ok(false) };
        if rec.state != OutboundState::Queued {
            return Ok(false);
        }
        let (hash, peer, queued_at) =
            (rec.payload_hash.clone(), rec.peer_endpoint_id.clone(), rec.queued_at_unix_ms);
        let mut entry = self.make_entry(state, message_id, &hash);
        entry.peer_endpoint_id = Some(peer);
        entry.queued_at_unix_ms = Some(queued_at);
        entry.reason = reason;
        let entry = self.append_durable(entry)?;
        self.apply(&entry);
        Ok(true)
    }

    /// Mark settled after a verified receipt. No-op unless currently queued.
    pub fn record_settled(&mut self, message_id: &str) -> Result<bool> {
        self.finish_outbound(message_id, DeliveryState::Settled, None)
    }

    /// Terminal refusal by the recipient (or an invalid receipt).
    pub fn record_refused(&mut self, message_id: &str, reason: &str) -> Result<bool> {
        self.finish_outbound(message_id, DeliveryState::Refused, Some(reason.to_string()))
    }

    /// Terminal expiry after the retry window elapsed.
    pub fn record_expired(&mut self, message_id: &str) -> Result<bool> {
        self.finish_outbound(
            message_id,
            DeliveryState::Expired,
            Some("retry window elapsed without a receipt".into()),
        )
    }

    /// Record a failed attempt and schedule the next one (in memory).
    pub fn note_attempt_failed(&mut self, message_id: &str, next_attempt_unix_ms: u64) {
        if let Some(rec) = self.outbound.get_mut(message_id) {
            rec.attempts = rec.attempts.saturating_add(1);
            rec.next_attempt_unix_ms = next_attempt_unix_ms;
        }
    }

    pub fn attempts(&self, message_id: &str) -> u32 {
        self.outbound.get(message_id).map(|r| r.attempts).unwrap_or(0)
    }

    /// Queued messages whose expiry has passed, and queued messages due for a
    /// retry. Due messages are leased until `lease_until_unix_ms` so a slow
    /// attempt is not started twice.
    pub fn take_due(
        &mut self,
        now: u64,
        expiry: Duration,
        lease_until_unix_ms: u64,
        max_due: usize,
    ) -> (Vec<String>, Vec<DueOutbound>) {
        let expiry_ms = expiry.as_millis() as u64;
        let mut expired = Vec::new();
        let mut due = Vec::new();
        for (id, rec) in self.outbound.iter_mut() {
            if rec.state != OutboundState::Queued {
                continue;
            }
            if now >= rec.queued_at_unix_ms.saturating_add(expiry_ms) {
                expired.push(id.clone());
                continue;
            }
            if rec.next_attempt_unix_ms > now || due.len() >= max_due {
                continue;
            }
            let (Some(payload), Some(addr)) = (rec.payload.clone(), rec.peer_addr.clone()) else {
                continue;
            };
            rec.next_attempt_unix_ms = lease_until_unix_ms;
            due.push(DueOutbound {
                message_id: id.clone(),
                payload,
                peer_addr: addr,
                queued_at_unix_ms: rec.queued_at_unix_ms,
            });
        }
        (expired, due)
    }

    // ----------------------------------------------------------------- inbound

    /// Persist inbound acceptance keyed by `(from, message_id)`.
    ///
    /// - new key → `received_peer` appended (fsync) → `Accepted`
    /// - same key, same hash → `duplicate_suppressed` appended → `Duplicate`
    /// - same key, different hash → nothing appended → `Conflict` (never ack)
    /// - per-peer quota exceeded → nothing appended → `QuotaExceeded`
    pub fn accept_inbound(
        &mut self,
        from_endpoint_id: &str,
        message_id: &str,
        payload: &str,
    ) -> Result<InboundOutcome> {
        let hash = payload_hash_hex(payload.as_bytes());
        let key = (from_endpoint_id.to_string(), message_id.to_string());
        if let Some(rec) = self.inbound.get(&key) {
            if rec.payload_hash != hash {
                return Ok(InboundOutcome::Conflict);
            }
            let mut entry = self.make_entry(DeliveryState::DuplicateSuppressed, message_id, &hash);
            entry.peer_endpoint_id = Some(from_endpoint_id.to_string());
            self.append_durable(entry)?;
            return Ok(InboundOutcome::Duplicate);
        }
        // O(1) live totals (tombstones are never scanned).
        let (count, bytes) = self.live_inbound.get(from_endpoint_id).copied().unwrap_or((0, 0));
        if count + 1 > self.limits.max_unconsumed_per_peer
            || bytes + payload.len() as u64 > self.limits.max_unconsumed_bytes_per_peer
        {
            return Ok(InboundOutcome::QuotaExceeded);
        }
        let mut entry = self.make_entry(DeliveryState::ReceivedPeer, message_id, &hash);
        entry.payload_hex = Some(hex::encode(payload.as_bytes()));
        entry.peer_endpoint_id = Some(from_endpoint_id.to_string());
        let entry = self.append_durable(entry)?;
        self.apply(&entry);
        Ok(InboundOutcome::Accepted)
    }

    /// True if `(from, message_id)` was durably accepted (consumed or not).
    pub fn already_received(&self, from_endpoint_id: &str, message_id: &str) -> bool {
        self.inbound
            .contains_key(&(from_endpoint_id.to_string(), message_id.to_string()))
    }

    /// All unconsumed inbox items ordered by journal `seq`.
    pub fn inbox_items(&self) -> Vec<InboxItem> {
        let mut items: Vec<_> = self
            .inbound
            .iter()
            .filter(|(_, r)| !r.consumed)
            .filter_map(|((from, id), r)| {
                Some(InboxItem {
                    seq: r.seq,
                    message_id: id.clone(),
                    payload_hash: r.payload_hash.clone(),
                    payload: r.payload.clone()?,
                    from_endpoint_id: from.clone(),
                    ts_unix_ms: r.ts_unix_ms,
                })
            })
            .collect();
        items.sort_by_key(|i| i.seq);
        items
    }

    pub fn unconsumed_count(&self) -> usize {
        self.live_inbound.values().map(|t| t.0).sum()
    }

    /// Acknowledge (consume) an inbox item; it leaves the inbox but its
    /// `(from, id, hash)` tombstone keeps duplicate suppression working until
    /// compaction drops it after `tombstone_retention`.
    pub fn consume(&mut self, from_endpoint_id: &str, message_id: &str) -> Result<ConsumeOutcome> {
        let key = (from_endpoint_id.to_string(), message_id.to_string());
        let Some(rec) = self.inbound.get(&key) else { return Ok(ConsumeOutcome::Unknown) };
        if rec.consumed {
            return Ok(ConsumeOutcome::AlreadyAcked);
        }
        let hash = rec.payload_hash.clone();
        let mut entry = self.make_entry(DeliveryState::Consumed, message_id, &hash);
        entry.peer_endpoint_id = Some(from_endpoint_id.to_string());
        let entry = self.append_durable(entry)?;
        self.apply(&entry);
        Ok(ConsumeOutcome::Acked)
    }

    // -------------------------------------------------------------- compaction

    /// Rewrite the journal with only live state: queued outbound, unconsumed
    /// inbound, and terminal/consumed tombstones younger than
    /// `tombstone_retention`. Original `seq` values are preserved.
    pub fn compact(&mut self) -> Result<()> {
        if self.closed {
            bail!("journal is closed (engine shut down)");
        }
        let now = now_unix_ms();
        let retention = self.limits.tombstone_retention.as_millis() as u64;
        let fresh = |ts: u64| now.saturating_sub(ts) < retention;

        self.outbound
            .retain(|_, r| r.state == OutboundState::Queued || fresh(r.last_ts_unix_ms));
        self.inbound.retain(|_, r| !r.consumed || fresh(r.ts_unix_ms));

        let mut snapshot: Vec<JournalEntry> = Vec::new();
        for (id, r) in &self.outbound {
            let state = match r.state {
                OutboundState::Queued => DeliveryState::QueuedLocal,
                OutboundState::Settled => DeliveryState::Settled,
                OutboundState::Refused => DeliveryState::Refused,
                OutboundState::Expired => DeliveryState::Expired,
            };
            snapshot.push(JournalEntry {
                seq: r.seq,
                state,
                message_id: id.clone(),
                payload_hash: r.payload_hash.clone(),
                payload_hex: r.payload.as_ref().map(|p| hex::encode(p.as_bytes())),
                peer_endpoint_id: Some(r.peer_endpoint_id.clone()),
                peer_addr: r.peer_addr.clone(),
                queued_at_unix_ms: Some(r.queued_at_unix_ms),
                reason: r.reason.clone(),
                ts_unix_ms: r.last_ts_unix_ms,
            });
        }
        for ((from, id), r) in &self.inbound {
            snapshot.push(JournalEntry {
                seq: r.seq,
                state: if r.consumed {
                    DeliveryState::Consumed
                } else {
                    DeliveryState::ReceivedPeer
                },
                message_id: id.clone(),
                payload_hash: r.payload_hash.clone(),
                payload_hex: r.payload.as_ref().map(|p| hex::encode(p.as_bytes())),
                peer_endpoint_id: Some(from.clone()),
                peer_addr: None,
                queued_at_unix_ms: None,
                reason: None,
                ts_unix_ms: r.ts_unix_ms,
            });
        }
        snapshot.sort_by_key(|e| e.seq);
        let high_water = self.next_seq.saturating_sub(1);
        if high_water > 0 && snapshot.last().map(|e| e.seq) != Some(high_water) {
            snapshot.push(JournalEntry {
                seq: high_water,
                state: DeliveryState::Checkpoint,
                message_id: String::new(),
                payload_hash: String::new(),
                payload_hex: None,
                peer_endpoint_id: None,
                peer_addr: None,
                queued_at_unix_ms: None,
                reason: None,
                ts_unix_ms: now,
            });
        }
        if snapshot.len() as u64 >= self.lines {
            self.lines_since_compact = 0;
            return Ok(());
        }

        let tmp = self.path.with_extension("jsonl.compact");
        {
            let _ = std::fs::remove_file(&tmp);
            let f = OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&tmp)
                .with_context(|| format!("create {}", tmp.display()))?;
            // Stream records to disk; never buffer the whole journal.
            let mut w = BufWriter::new(f);
            for e in &snapshot {
                serde_json::to_writer(&mut w, e)?;
                w.write_all(b"\n")?;
            }
            let f = w.into_inner().map_err(|e| e.into_error())?;
            f.sync_all()?;
        }
        std::fs::rename(&tmp, &self.path)
            .with_context(|| format!("replace {}", self.path.display()))?;
        if let Some(dir) = self.path.parent() {
            sync_dir(dir)?;
        }
        self.lines = snapshot.len() as u64;
        self.lines_since_compact = 0;
        Ok(())
    }

    // ------------------------------------------------------------------ writes

    fn make_entry(&mut self, state: DeliveryState, message_id: &str, payload_hash: &str) -> JournalEntry {
        let seq = self.next_seq;
        self.next_seq += 1;
        JournalEntry {
            seq,
            state,
            message_id: message_id.to_string(),
            payload_hash: payload_hash.to_string(),
            payload_hex: None,
            peer_endpoint_id: None,
            peer_addr: None,
            queued_at_unix_ms: None,
            reason: None,
            ts_unix_ms: now_unix_ms(),
        }
    }

    fn append_durable(&mut self, entry: JournalEntry) -> Result<JournalEntry> {
        if self.closed {
            bail!("journal is closed (engine shut down)");
        }
        let mut line = serde_json::to_vec(&entry)?;
        line.push(b'\n');
        let mut file = OpenOptions::new()
            .append(true)
            .create(true)
            .mode(0o600)
            .open(&self.path)
            .with_context(|| format!("open journal {}", self.path.display()))?;
        // One write per record so a crash leaves at most one torn final line.
        file.write_all(&line)?;
        file.sync_all()?;
        self.lines += 1;
        self.lines_since_compact += 1;
        if self.lines_since_compact >= self.limits.compact_every_lines {
            // Best effort: entry is already durable; compaction failure is logged.
            if let Err(err) = self.compact_after_append(&entry) {
                warn!(error = %err, "journal compaction failed");
            }
        }
        Ok(entry)
    }

    fn compact_after_append(&mut self, entry: &JournalEntry) -> Result<()> {
        // Make sure the in-memory index reflects `entry` before snapshotting.
        self.apply(entry);
        self.compact()
    }
}

/// Stream JSONL entries. If the **last** record is unterminated or does not
/// parse, truncate the file to the end of the previous good record (it was
/// never fsynced/acknowledged as a whole). Any other bad record is fatal.
fn read_entries_recovering_tail(path: &Path, mut on_entry: impl FnMut(JournalEntry)) -> Result<()> {
    let mut reader = BufReader::new(File::open(path)?);
    let mut offset: u64 = 0;
    // First bad record seen so far: (start offset). Fatal if any non-empty
    // record follows it; truncated if it is the last one.
    let mut bad_at: Option<u64> = None;
    let mut line = Vec::new();
    loop {
        line.clear();
        let n = reader.read_until(b'\n', &mut line)?;
        if n == 0 {
            break;
        }
        let start = offset;
        offset += n as u64;
        let terminated = line.last() == Some(&b'\n');
        let body = if terminated { &line[..line.len() - 1] } else { &line[..] };
        if body.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        if let Some(bad) = bad_at {
            bail!(
                "corrupt journal record at byte {bad} in {} (not the final record; refusing to start)",
                path.display()
            );
        }
        let parsed = if terminated {
            serde_json::from_slice::<JournalEntry>(body).ok()
        } else {
            None // unterminated tail: never fsynced as a whole record
        };
        match parsed {
            Some(e) => on_entry(e),
            None => bad_at = Some(start),
        }
    }
    if let Some(bad) = bad_at {
        warn!(path = %path.display(), offset = bad, "truncating torn final journal record");
        let mut f = OpenOptions::new().write(true).open(path)?;
        f.set_len(bad)?;
        f.seek(SeekFrom::End(0))?;
        f.sync_all()?;
    }
    Ok(())
}

fn sync_dir(dir: &Path) -> Result<()> {
    File::open(dir)?.sync_all()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn addr() -> serde_json::Value {
        serde_json::json!({"id": "x", "addrs": []})
    }

    #[test]
    fn durable_append_and_duplicate_suppression() {
        let dir = tempdir().unwrap();
        let mut j = Journal::open(dir.path()).unwrap();
        assert_eq!(j.accept_inbound("peer-a", "m1", "hello").unwrap(), InboundOutcome::Accepted);
        assert!(j.already_received("peer-a", "m1"));
        assert_eq!(j.accept_inbound("peer-a", "m1", "hello").unwrap(), InboundOutcome::Duplicate);
        assert_eq!(j.inbox_items().len(), 1);

        let j2 = Journal::open(dir.path()).unwrap();
        assert!(j2.already_received("peer-a", "m1"));
        assert_eq!(j2.inbox_items().len(), 1);
    }

    // Regression (review P1 #1): inbound keyed by (sender, id) with hash compare.
    #[test]
    fn inbound_is_keyed_by_sender_and_conflicts_are_not_duplicates() {
        let dir = tempdir().unwrap();
        let mut j = Journal::open(dir.path()).unwrap();
        assert_eq!(j.accept_inbound("a", "m1", "from a").unwrap(), InboundOutcome::Accepted);
        assert_eq!(j.accept_inbound("c", "m1", "from c").unwrap(), InboundOutcome::Accepted);
        assert_eq!(j.accept_inbound("a", "m1", "changed").unwrap(), InboundOutcome::Conflict);
        let items = j.inbox_items();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].payload, "from a");
        // Outbound ids are a separate namespace.
        j.enqueue_outbound("m2", "out", "a", addr(), 0).unwrap().unwrap();
        j.record_settled("m2").unwrap();
        assert_eq!(j.accept_inbound("a", "m2", "in").unwrap(), InboundOutcome::Accepted);
    }

    #[test]
    fn outbound_reuse_with_different_payload_or_peer_is_conflict() {
        let dir = tempdir().unwrap();
        let mut j = Journal::open(dir.path()).unwrap();
        assert_eq!(j.enqueue_outbound("m", "p", "b", addr(), 0).unwrap(), Ok(EnqueueOutcome::New));
        assert_eq!(
            j.enqueue_outbound("m", "p", "b", addr(), 0).unwrap(),
            Ok(EnqueueOutcome::Existing(OutboundState::Queued))
        );
        assert!(matches!(j.enqueue_outbound("m", "q", "b", addr(), 0).unwrap(), Err(EnqueueError::Conflict(_))));
        assert!(matches!(j.enqueue_outbound("m", "p", "c", addr(), 0).unwrap(), Err(EnqueueError::Conflict(_))));
    }

    // Regression (review P1 #2): torn final record is truncated, earlier corruption is fatal.
    #[test]
    fn torn_final_record_is_truncated_and_recovered() {
        let dir = tempdir().unwrap();
        {
            let mut j = Journal::open(dir.path()).unwrap();
            j.accept_inbound("p", "m1", "hi").unwrap();
        }
        let path = dir.path().join("journal/peer.jsonl");
        let good_len = std::fs::metadata(&path).unwrap().len();
        let mut f = OpenOptions::new().append(true).open(&path).unwrap();
        f.write_all(b"{\"seq\":2,\"state\":\"recei").unwrap();
        drop(f);
        let j = Journal::open(dir.path()).expect("recover torn tail");
        assert_eq!(j.inbox_items().len(), 1);
        assert_eq!(std::fs::metadata(&path).unwrap().len(), good_len);

        // A terminated-but-garbage final line is also a torn final record.
        let mut f = OpenOptions::new().append(true).open(&path).unwrap();
        f.write_all(b"garbage\n").unwrap();
        drop(f);
        assert_eq!(Journal::open(dir.path()).unwrap().inbox_items().len(), 1);
    }

    #[test]
    fn mid_file_corruption_is_fatal() {
        let dir = tempdir().unwrap();
        {
            let mut j = Journal::open(dir.path()).unwrap();
            j.accept_inbound("p", "m1", "hi").unwrap();
        }
        let path = dir.path().join("journal/peer.jsonl");
        let good = std::fs::read_to_string(&path).unwrap();
        std::fs::write(&path, format!("garbage\n{good}")).unwrap();
        let err = Journal::open(dir.path()).err().expect("must refuse").to_string();
        assert!(err.contains("not the final record"), "{err}");
    }

    // Regression (review P2 #11): compaction keeps live state and seq, drops old tombstones.
    #[test]
    fn compaction_drops_expired_tombstones_and_keeps_live_state() {
        let dir = tempdir().unwrap();
        let limits = JournalLimits { tombstone_retention: Duration::ZERO, ..Default::default() };
        let mut j = Journal::open_with(dir.path(), limits.clone()).unwrap();
        for i in 0..20 {
            j.accept_inbound("p", &format!("old{i}"), "x").unwrap();
            j.consume("p", &format!("old{i}")).unwrap();
            j.enqueue_outbound(&format!("o{i}"), "y", "q", addr(), 0).unwrap().unwrap();
            j.record_settled(&format!("o{i}")).unwrap();
        }
        j.accept_inbound("p", "live", "keep").unwrap();
        j.enqueue_outbound("pending", "z", "q", addr(), 0).unwrap().unwrap();
        let live_seq = j.inbox_items()[0].seq;
        let before = j.line_count();
        drop(j);

        let j = Journal::open_with(dir.path(), limits).unwrap();
        assert!(j.line_count() < before, "{} !< {before}", j.line_count());
        assert_eq!(j.line_count(), 2);
        assert_eq!(j.inbox_items()[0].seq, live_seq);
        assert_eq!(j.outbound_state("pending"), Some(OutboundState::Queued));

        // With retention, consumed tombstones survive compaction and still dedupe.
        let dir2 = tempdir().unwrap();
        let mut j = Journal::open(dir2.path()).unwrap();
        j.accept_inbound("p", "m", "x").unwrap();
        j.consume("p", "m").unwrap();
        drop(j);
        let mut j = Journal::open(dir2.path()).unwrap();
        assert_eq!(j.line_count(), 2, "consumed tombstone + seq checkpoint");
        assert_eq!(j.accept_inbound("p", "m", "x").unwrap(), InboundOutcome::Duplicate);
        assert_eq!(j.inbox_items().len(), 0);
    }

    // Regression (Codex fix-round 1 P1): seq high-water survives compaction.
    #[test]
    fn inbox_seq_stays_monotonic_after_full_compaction() {
        let dir = tempdir().unwrap();
        let limits = JournalLimits { tombstone_retention: Duration::ZERO, ..Default::default() };
        let mut j = Journal::open_with(dir.path(), limits.clone()).unwrap();
        for i in 0..5 {
            j.accept_inbound("p", &format!("m{i}"), "x").unwrap();
            j.consume("p", &format!("m{i}")).unwrap();
        }
        let last_cursor = 10;
        drop(j);
        let j = Journal::open_with(dir.path(), limits.clone()).unwrap();
        assert_eq!(j.line_count(), 1, "only the checkpoint should remain");
        drop(j);
        let mut j = Journal::open_with(dir.path(), limits).unwrap();
        j.accept_inbound("p", "new", "y").unwrap();
        assert!(j.inbox_items()[0].seq > last_cursor, "seq went backwards: {}", j.inbox_items()[0].seq);
    }

    // Regression (Codex fix-round 1 P2): refreshed peer address is durable.
    #[test]
    fn refreshed_peer_address_survives_restart() {
        let dir = tempdir().unwrap();
        let mut j = Journal::open(dir.path()).unwrap();
        let old = serde_json::json!({"id": "x", "addrs": [{"Ip": "127.0.0.1:1"}]});
        let new = serde_json::json!({"id": "x", "addrs": [{"Ip": "127.0.0.1:2"}]});
        j.enqueue_outbound("m", "p", "x", old, 0).unwrap().unwrap();
        j.enqueue_outbound("m", "p", "x", new.clone(), 0).unwrap().unwrap();
        drop(j);
        let mut j = Journal::open(dir.path()).unwrap();
        let (_, due) = j.take_due(now_unix_ms(), Duration::from_secs(3600), 0, 10);
        assert_eq!(due[0].peer_addr, new);
    }

    // Regression (Codex fix-round 1 P2): retry fan-out is bounded per tick.
    #[test]
    fn take_due_respects_max_due() {
        let dir = tempdir().unwrap();
        let mut j = Journal::open(dir.path()).unwrap();
        for i in 0..10 {
            j.enqueue_outbound(&format!("m{i}"), "p", "x", addr(), 0).unwrap().unwrap();
        }
        let now = now_unix_ms();
        let (_, due) = j.take_due(now, Duration::from_secs(3600), now + 60_000, 3);
        assert_eq!(due.len(), 3);
        let (_, due) = j.take_due(now, Duration::from_secs(3600), now + 60_000, 100);
        assert_eq!(due.len(), 7, "leased items must not be handed out twice");
    }

    #[test]
    fn outbox_is_bounded_by_count_and_bytes() {
        let dir = tempdir().unwrap();
        let limits = JournalLimits { max_outbox: 2, max_outbox_bytes: 10, ..Default::default() };
        let mut j = Journal::open_with(dir.path(), limits).unwrap();
        j.enqueue_outbound("a", "12345", "x", addr(), 0).unwrap().unwrap();
        assert!(matches!(j.enqueue_outbound("b", "123456", "x", addr(), 0).unwrap(), Err(EnqueueError::OutboxFull(_))));
        j.enqueue_outbound("b", "1", "x", addr(), 0).unwrap().unwrap();
        assert!(matches!(j.enqueue_outbound("c", "1", "x", addr(), 0).unwrap(), Err(EnqueueError::OutboxFull(_))));
    }

    // Regression (Codex fix-round 3 P2): live quota totals stay exact across
    // accept/consume/replay/compaction without scanning tombstones.
    #[test]
    fn live_inbound_totals_track_accept_consume_and_replay() {
        let dir = tempdir().unwrap();
        let limits = JournalLimits { compact_every_lines: 3, ..Default::default() };
        let mut j = Journal::open_with(dir.path(), limits.clone()).unwrap();
        for i in 0..10 {
            j.accept_inbound("p", &format!("m{i}"), "abc").unwrap();
        }
        for i in 0..4 {
            j.consume("p", &format!("m{i}")).unwrap();
        }
        assert_eq!(j.unconsumed_count(), 6);
        assert_eq!(j.live_inbound.get("p"), Some(&(6, 18)));
        drop(j);
        let j = Journal::open_with(dir.path(), limits).unwrap();
        assert_eq!(j.live_inbound.get("p"), Some(&(6, 18)));
        assert_eq!(j.inbox_items().len(), 6);
    }

    #[test]
    fn closed_journal_refuses_writes() {
        let dir = tempdir().unwrap();
        let mut j = Journal::open(dir.path()).unwrap();
        j.accept_inbound("p", "m", "x").unwrap();
        j.close();
        assert!(j.accept_inbound("p", "m2", "y").is_err());
        assert!(j.consume("p", "m").is_err());
        assert!(j.enqueue_outbound("o", "z", "q", addr(), 0).is_err());
    }

    #[test]
    fn quota_limits_unconsumed_inbound_per_peer() {
        let dir = tempdir().unwrap();
        let limits = JournalLimits { max_unconsumed_per_peer: 1, ..Default::default() };
        let mut j = Journal::open_with(dir.path(), limits).unwrap();
        assert_eq!(j.accept_inbound("p", "1", "a").unwrap(), InboundOutcome::Accepted);
        assert_eq!(j.accept_inbound("p", "2", "b").unwrap(), InboundOutcome::QuotaExceeded);
        assert_eq!(j.accept_inbound("other", "2", "b").unwrap(), InboundOutcome::Accepted);
        j.consume("p", "1").unwrap();
        assert_eq!(j.accept_inbound("p", "2", "b").unwrap(), InboundOutcome::Accepted);
    }
}
