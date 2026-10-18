#![allow(dead_code)]
use std::path::Path;
use std::time::Duration;

use iroh::endpoint::presets;
use iroh::{Endpoint, EndpointId, RelayMode};
use peer_engine::{DeviceIdentity, EngineConfig, PeerEngine, RetryPolicy, ALPN};

/// Pre-create (or load) the device identity so rosters can be configured
/// before the engine starts.
pub fn id_of(dir: &Path) -> EndpointId {
    DeviceIdentity::load_or_create(dir).unwrap().secret_key().public()
}

pub fn fast_retry() -> RetryPolicy {
    RetryPolicy {
        initial_backoff: Duration::from_millis(50),
        max_backoff: Duration::from_millis(200),
        expiry: Duration::from_secs(7 * 24 * 60 * 60),
        tick: Duration::from_millis(25),
        attempt_timeout: Duration::from_secs(5),
    }
}

pub fn config(dir: &Path, peers: &[EndpointId]) -> EngineConfig {
    let mut c = EngineConfig::new(dir).direct_only();
    c.allowed_peers = peers.to_vec();
    c.retry = fast_retry();
    c
}

pub async fn start(dir: &Path, peers: &[EndpointId]) -> PeerEngine {
    PeerEngine::start(config(dir, peers)).await.expect("start engine")
}

/// A bare iroh endpoint speaking our ALPN (used to impersonate a misbehaving peer).
pub async fn raw_endpoint() -> Endpoint {
    Endpoint::builder(presets::N0)
        .relay_mode(RelayMode::Disabled)
        .alpns(vec![ALPN.to_vec()])
        .bind()
        .await
        .expect("bind raw endpoint")
}

pub async fn wait_until<F, Fut>(timeout: Duration, mut f: F) -> bool
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = bool>,
{
    let deadline = tokio::time::Instant::now() + timeout;
    while tokio::time::Instant::now() < deadline {
        if f().await {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    false
}
