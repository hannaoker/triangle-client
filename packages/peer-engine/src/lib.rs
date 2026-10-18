//! Triangle peer connectivity engine.
//!
//! This crate owns device identity, iroh endpoint connectivity, a durable peer
//! journal, the message/receipt wire protocol, and a versioned private Unix IPC
//! surface for a future Node supervisor/broker.
//!
//! Hard boundaries (pivot plan §5 / §8):
//! - Never accepts MESH bearers, controller credentials, or workload keys.
//! - Does not emulate MESH claims or launch existing runtime drains.
//! - Sole writer of its peer journal under a configurable state directory.

pub mod engine;
pub mod identity;
pub mod ipc;
pub mod journal;
pub mod protocol;

pub use engine::{DeliveryError, EngineConfig, PeerEngine, RelayPreference, RetryPolicy, CLOSE_NOT_MEMBER};
pub use identity::DeviceIdentity;
pub use ipc::{IpcClient, IpcServer, IPC_PROTOCOL_VERSION, MAX_IPC_REQUEST_BYTES, MAX_IPC_RESPONSE_BYTES};
pub use journal::{DeliveryState, InboxItem, Journal, JournalEntry, JournalLimits};
pub use protocol::{PeerMessage, PeerReceipt, PeerReject, ALPN, MAX_FRAME_BYTES, MAX_PAYLOAD_BYTES};

/// Crate version string for status/IPC hello responses.
pub const ENGINE_VERSION: &str = env!("CARGO_PKG_VERSION");
