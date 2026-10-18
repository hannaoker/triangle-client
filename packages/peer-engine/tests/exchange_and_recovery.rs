//! Integration proofs for M2-start peer connectivity (local / in-process).
//!
//! Proven here:
//! - two engines exchange a message with a durable receipt
//! - identity + journal survive restart
//! - duplicate redelivery after restart is suppressed (one inbox item)
//! - versioned Unix IPC hello/status works
//!
//! Not proven here (called out in README / PR):
//! - NAT traversal across real residential/cellular networks
//! - forced-relay path with UDP blocked
//! - real harness execution through the peer-local adapter
//! - wrong-key / non-member rejection against a signed roster

use std::time::Duration;

use peer_engine::ipc::IpcClient;
use peer_engine::{EngineConfig, IpcServer, PeerEngine};
use tempfile::tempdir;

mod common;
use common::{id_of, start};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn two_engines_exchange_message_with_receipt() {
    let dir_a = tempdir().unwrap();
    let dir_b = tempdir().unwrap();

    let (id_a, id_b) = (id_of(dir_a.path()), id_of(dir_b.path()));
    let engine_a = start(dir_a.path(), &[id_b]).await;
    let engine_b = start(dir_b.path(), &[id_a]).await;

    // Give accept loops a moment to arm.
    tokio::time::sleep(Duration::from_millis(50)).await;

    let message_id = "exchange-msg-1".to_string();
    let receipt = engine_a
        .send_message(engine_b.endpoint_addr(), &message_id, "hello from A")
        .await
        .expect("send");

    assert_eq!(receipt.message_id, message_id);
    assert_eq!(receipt.status, "received_peer");
    assert!(!receipt.duplicate);

    tokio::time::timeout(Duration::from_secs(5), engine_b.wait_inbox_count(1))
        .await
        .expect("inbox wait timed out");
    let inbox = engine_b.inbox().await;
    assert_eq!(inbox.len(), 1);
    assert_eq!(inbox[0].message_id, message_id);
    assert_eq!(inbox[0].payload, "hello from A");
    assert_eq!(inbox[0].from_endpoint_id, engine_a.endpoint_id_hex());

    engine_a.shutdown().await;
    engine_b.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn restart_and_duplicate_redelivery_recovery() {
    let dir_a = tempdir().unwrap();
    let dir_b = tempdir().unwrap();

    let (id_a, id_b) = (id_of(dir_a.path()), id_of(dir_b.path()));
    let engine_a = start(dir_a.path(), &[id_b]).await;
    let engine_b = start(dir_b.path(), &[id_a]).await;

    tokio::time::sleep(Duration::from_millis(50)).await;

    let message_id = "stable-msg-1".to_string();
    let id_b_hex = engine_b.endpoint_id_hex();
    let addr_b = engine_b.endpoint_addr();

    let receipt1 = engine_a
        .send_message(addr_b.clone(), &message_id, "persist me")
        .await
        .expect("first send");
    assert!(!receipt1.duplicate);

    tokio::time::timeout(Duration::from_secs(5), engine_b.wait_inbox_count(1))
        .await
        .expect("inbox wait");
    assert_eq!(engine_b.inbox().await.len(), 1);

    // Restart B from the same state dir (identity + journal).
    engine_b.shutdown().await;
    tokio::time::sleep(Duration::from_millis(100)).await;

    let engine_b2 = start(dir_b.path(), &[id_a]).await;
    assert_eq!(engine_b2.endpoint_id_hex(), id_b_hex);
    assert_eq!(engine_b2.inbox().await.len(), 1);

    tokio::time::sleep(Duration::from_millis(50)).await;

    // A redelivers the same logical message_id (lost-receipt / retry
    // scenario). A settled message is never retransmitted by the same
    // journal, so simulate a sender that lost its journal: same device key,
    // fresh state dir.
    let dir_a2 = tempdir().unwrap();
    std::fs::create_dir_all(dir_a2.path().join("identity")).unwrap();
    std::fs::copy(
        dir_a.path().join("identity/device.key"),
        dir_a2.path().join("identity/device.key"),
    )
    .unwrap();
    engine_a.clone().shutdown().await;
    let engine_a = start(dir_a2.path(), &[id_b]).await;
    let receipt2 = engine_a
        .send_message(engine_b2.endpoint_addr(), &message_id, "persist me")
        .await
        .expect("redeliver");
    assert!(
        receipt2.duplicate,
        "recipient must signal duplicate suppression"
    );
    assert_eq!(engine_b2.inbox().await.len(), 1, "inbox must not duplicate");

    engine_a.shutdown().await;
    engine_b2.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unix_ipc_hello_and_status() {
    let dir = tempdir().unwrap();
    let engine = PeerEngine::start(EngineConfig::new(dir.path()).direct_only())
        .await
        .expect("start");
    let ipc = IpcServer::bind(engine.clone()).await.expect("bind ipc");
    let socket = ipc.socket_path().to_path_buf();
    tokio::spawn(async move {
        let _ = ipc.serve().await;
    });

    // Wait briefly for the listener.
    tokio::time::sleep(Duration::from_millis(50)).await;

    let mut client = IpcClient::connect(&socket).await.expect("connect ipc");
    let hello = client
        .call("hello", serde_json::json!({}))
        .await
        .expect("hello");
    assert_eq!(hello["protocol_version"], 1);
    assert_eq!(hello["endpoint_id"], engine.endpoint_id_hex());

    let status = client
        .call("status", serde_json::json!({}))
        .await
        .expect("status");
    assert_eq!(status["endpoint_id"], engine.endpoint_id_hex());

    // Secrets confinement: MESH credentials are refused.
    let err = client
        .call(
            "status",
            serde_json::json!({ "mesh_bearer": "mesh_should_never_be_here" }),
        )
        .await
        .expect_err("must refuse mesh bearer");
    assert!(err.to_string().contains("secrets_confined"));

    engine.shutdown().await;
}
