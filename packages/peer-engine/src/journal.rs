//! Append-only peer journal with durable writes before notify.
//!
//! The engine is the sole writer. Entries are JSONL; each append is flushed and
//! `fsync`ed before the caller may notify local consumers.

use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use crate::protocol::payload_hash_hex;

/// Product-aligned delivery states from the pivot plan §7 (subset for M2 start).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeliveryState {
    QueuedLocal,
    ReceivedPeer,
    Settled,
    DuplicateSuppressed,
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
    pub ts_unix_ms: u64,
}

/// In-memory index over an append-only journal file.
pub struct Journal {
    path: PathBuf,
    next_seq: AtomicU64,
    /// message_id → latest non-duplicate state for that id.
    by_message: HashMap<String, DeliveryState>,
    /// Received payloads (message_id → decoded UTF-8 body when available).
    inbox: HashMap<String, InboxItem>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct InboxItem {
    pub message_id: String,
    pub payload_hash: String,
    pub payload: String,
    pub from_endpoint_id: String,
    pub ts_unix_ms: u64,
}

impl Journal {
    /// Open or create `state_dir/journal/peer.jsonl` with private permissions.
    pub fn open(state_dir: impl AsRef<Path>) -> Result<Self> {
        let journal_dir = state_dir.as_ref().join("journal");
        if !journal_dir.exists() {
            std::fs::create_dir_all(&journal_dir)?;
        }
        let mut dir_perms = std::fs::metadata(&journal_dir)?.permissions();
        dir_perms.set_mode(0o700);
        std::fs::set_permissions(&journal_dir, dir_perms)?;

        let path = journal_dir.join("peer.jsonl");
        let mut by_message = HashMap::new();
        let mut inbox = HashMap::new();
        let mut next_seq = 1u64;

        if path.exists() {
            let mode = std::fs::metadata(&path)?.permissions().mode() & 0o777;
            if mode & 0o077 != 0 {
                anyhow::bail!(
                    "refusing journal {}: mode {:04o} allows group/other (need 0600)",
                    path.display(),
                    mode
                );
            }
            let file = File::open(&path)?;
            for line in BufReader::new(file).lines() {
                let line = line?;
                if line.trim().is_empty() {
                    continue;
                }
                let entry: JournalEntry = serde_json::from_str(&line)
                    .with_context(|| format!("parse journal line in {}", path.display()))?;
                next_seq = next_seq.max(entry.seq.saturating_add(1));
                match entry.state {
                    DeliveryState::DuplicateSuppressed => {
                        // Keep prior state; record that we saw a duplicate.
                    }
                    other => {
                        by_message.insert(entry.message_id.clone(), other.clone());
                        if other == DeliveryState::ReceivedPeer || other == DeliveryState::Settled {
                            if let Some(payload_hex) = &entry.payload_hex {
                                if let Ok(bytes) = hex::decode(payload_hex) {
                                    if let Ok(payload) = String::from_utf8(bytes) {
                                        if let Some(from) = &entry.peer_endpoint_id {
                                            inbox.insert(
                                                entry.message_id.clone(),
                                                InboxItem {
                                                    message_id: entry.message_id.clone(),
                                                    payload_hash: entry.payload_hash.clone(),
                                                    payload,
                                                    from_endpoint_id: from.clone(),
                                                    ts_unix_ms: entry.ts_unix_ms,
                                                },
                                            );
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        } else {
            let file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&path)?;
            drop(file);
            let mut perms = std::fs::metadata(&path)?.permissions();
            perms.set_mode(0o600);
            std::fs::set_permissions(&path, perms)?;
        }

        Ok(Self {
            path,
            next_seq: AtomicU64::new(next_seq),
            by_message,
            inbox,
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// True if this message_id was already durably accepted as `received_peer` or later.
    pub fn already_received(&self, message_id: &str) -> bool {
        matches!(
            self.by_message.get(message_id),
            Some(DeliveryState::ReceivedPeer | DeliveryState::Settled)
        )
    }

    pub fn state_of(&self, message_id: &str) -> Option<&DeliveryState> {
        self.by_message.get(message_id)
    }

    pub fn inbox_items(&self) -> Vec<InboxItem> {
        let mut items: Vec<_> = self.inbox.values().cloned().collect();
        items.sort_by_key(|i| i.ts_unix_ms);
        items
    }

    /// Persist an outbound enqueue before network send.
    pub fn append_queued_local(
        &mut self,
        message_id: &str,
        payload: &[u8],
        peer_endpoint_id: &str,
    ) -> Result<JournalEntry> {
        let entry = self.make_entry(
            DeliveryState::QueuedLocal,
            message_id,
            &payload_hash_hex(payload),
            Some(hex::encode(payload)),
            Some(peer_endpoint_id.to_string()),
        );
        self.append_durable(entry)
    }

    /// Persist inbound acceptance. Returns `(entry, is_duplicate)`.
    ///
    /// On duplicate: appends a `duplicate_suppressed` record and does not change
    /// the inbox. Caller should still emit a receipt.
    pub fn append_received_peer(
        &mut self,
        message_id: &str,
        payload: &[u8],
        from_endpoint_id: &str,
    ) -> Result<(JournalEntry, bool)> {
        let hash = payload_hash_hex(payload);
        if self.already_received(message_id) {
            let entry = self.make_entry(
                DeliveryState::DuplicateSuppressed,
                message_id,
                &hash,
                None,
                Some(from_endpoint_id.to_string()),
            );
            let entry = self.append_durable(entry)?;
            return Ok((entry, true));
        }

        let entry = self.make_entry(
            DeliveryState::ReceivedPeer,
            message_id,
            &hash,
            Some(hex::encode(payload)),
            Some(from_endpoint_id.to_string()),
        );
        let entry = self.append_durable(entry)?;
        if let Ok(text) = String::from_utf8(payload.to_vec()) {
            self.inbox.insert(
                message_id.to_string(),
                InboxItem {
                    message_id: message_id.to_string(),
                    payload_hash: hash,
                    payload: text,
                    from_endpoint_id: from_endpoint_id.to_string(),
                    ts_unix_ms: entry.ts_unix_ms,
                },
            );
        }
        Ok((entry, false))
    }

    /// Mark settled after a receipt has been processed.
    pub fn append_settled(&mut self, message_id: &str, payload_hash: &str) -> Result<JournalEntry> {
        let entry = self.make_entry(
            DeliveryState::Settled,
            message_id,
            payload_hash,
            None,
            None,
        );
        self.append_durable(entry)
    }

    fn make_entry(
        &self,
        state: DeliveryState,
        message_id: &str,
        payload_hash: &str,
        payload_hex: Option<String>,
        peer_endpoint_id: Option<String>,
    ) -> JournalEntry {
        JournalEntry {
            seq: self.next_seq.fetch_add(1, Ordering::SeqCst),
            state,
            message_id: message_id.to_string(),
            payload_hash: payload_hash.to_string(),
            payload_hex,
            peer_endpoint_id,
            ts_unix_ms: now_unix_ms(),
        }
    }

    fn append_durable(&mut self, entry: JournalEntry) -> Result<JournalEntry> {
        let line = serde_json::to_string(&entry)?;
        let mut file = OpenOptions::new()
            .append(true)
            .create(true)
            .mode(0o600)
            .open(&self.path)
            .with_context(|| format!("open journal {}", self.path.display()))?;
        file.write_all(line.as_bytes())?;
        file.write_all(b"\n")?;
        file.flush()?;
        file.sync_all()?;
        if entry.state != DeliveryState::DuplicateSuppressed {
            self.by_message
                .insert(entry.message_id.clone(), entry.state.clone());
        }
        Ok(entry)
    }
}

fn now_unix_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn durable_append_and_duplicate_suppression() {
        let dir = tempdir().unwrap();
        let mut j = Journal::open(dir.path()).unwrap();
        j.append_received_peer("m1", b"hello", "peer-a").unwrap();
        assert!(j.already_received("m1"));
        let (_e, dup) = j.append_received_peer("m1", b"hello", "peer-a").unwrap();
        assert!(dup);
        assert_eq!(j.inbox_items().len(), 1);

        let j2 = Journal::open(dir.path()).unwrap();
        assert!(j2.already_received("m1"));
        assert_eq!(j2.inbox_items().len(), 1);
    }
}
