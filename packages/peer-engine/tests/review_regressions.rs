//! Regression tests for the Codex/reviewer findings on PR #83.
//! Each test names the finding it covers (see docs/reviews in the parent repo
//! and the PR description). The pre-fix behaviour of P1 #1-#5 and P2 #7 was
//! reproduced with equivalent probes against cf44d1e (all failed).

use std::time::{Duration, Instant};

use iroh::{EndpointAddr, SecretKey};
use peer_engine::ipc::IpcClient;
use peer_engine::protocol::{read_envelope, write_envelope, PeerMessage, PeerReceipt, WireEnvelope};
use peer_engine::{DeliveryError, EngineConfig, IpcServer, PeerEngine, RelayPreference, RetryPolicy, ALPN};
use tempfile::tempdir;

mod common;
use common::{config, id_of, raw_endpoint, start, wait_until};

async fn outbound_state(e: &PeerEngine, id: &str) -> Option<String> {
    e.outbound_status(id).await.map(|s| s.state)
}

// ---------------------------------------------------------------- P1 #1

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn p1_1_same_id_from_different_senders_are_both_delivered() {
    let (da, db, dc) = (tempdir().unwrap(), tempdir().unwrap(), tempdir().unwrap());
    let (ia, ib, ic) = (id_of(da.path()), id_of(db.path()), id_of(dc.path()));
    let a = start(da.path(), &[ib]).await;
    let b = start(db.path(), &[ia, ic]).await;
    let c = start(dc.path(), &[ib]).await;
    assert!(!a.send_message(b.endpoint_addr(), "m1", "from A").await.unwrap().duplicate);
    let r = c.send_message(b.endpoint_addr(), "m1", "from C").await.unwrap();
    assert!(!r.duplicate, "C's distinct message must not be acked as a duplicate");
    let inbox = b.inbox().await;
    assert_eq!(inbox.len(), 2);
    assert_eq!(inbox[1].payload, "from C");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn p1_1_outbound_id_does_not_block_inbound() {
    let (da, db) = (tempdir().unwrap(), tempdir().unwrap());
    let (ia, ib) = (id_of(da.path()), id_of(db.path()));
    let a = start(da.path(), &[ib]).await;
    let b = start(db.path(), &[ia]).await;
    a.send_message(b.endpoint_addr(), "x1", "A->B").await.unwrap();
    let r = b.send_message(a.endpoint_addr(), "x1", "B->A").await.unwrap();
    assert!(!r.duplicate);
    assert_eq!(a.inbox().await.len(), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn p1_1_same_sender_same_id_different_payload_is_refused_not_acked() {
    let (da, da2, db) = (tempdir().unwrap(), tempdir().unwrap(), tempdir().unwrap());
    let (ia, ib) = (id_of(da.path()), id_of(db.path()));
    // A2 = same device key as A, fresh journal (simulates a sender that lost state).
    std::fs::create_dir_all(da2.path().join("identity")).unwrap();
    std::fs::copy(da.path().join("identity/device.key"), da2.path().join("identity/device.key")).unwrap();
    let b = start(db.path(), &[ia]).await;
    let a = start(da.path(), &[ib]).await;
    a.send_message(b.endpoint_addr(), "m1", "original").await.unwrap();
    a.shutdown().await;

    let a2 = start(da2.path(), &[ib]).await;
    let err = a2.send_message(b.endpoint_addr(), "m1", "changed").await.unwrap_err();
    assert!(matches!(err, DeliveryError::Refused { ref code, .. } if code == "conflict"), "{err:?}");
    assert_eq!(outbound_state(&a2, "m1").await.as_deref(), Some("refused"));
    let inbox = b.inbox().await;
    assert_eq!(inbox.len(), 1);
    assert_eq!(inbox[0].payload, "original");
}

// ---------------------------------------------------------------- P1 #2 (engine level)

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn p1_2_engine_restarts_after_torn_journal_tail() {
    use std::io::Write;
    let (da, db) = (tempdir().unwrap(), tempdir().unwrap());
    let (ia, ib) = (id_of(da.path()), id_of(db.path()));
    let a = start(da.path(), &[ib]).await;
    let b = start(db.path(), &[ia]).await;
    a.send_message(b.endpoint_addr(), "m1", "durable").await.unwrap();
    b.shutdown().await;
    let mut f = std::fs::OpenOptions::new()
        .append(true)
        .open(db.path().join("journal/peer.jsonl"))
        .unwrap();
    f.write_all(b"{\"seq\":99,\"state\":\"received_pe").unwrap();
    drop(f);
    let b2 = start(db.path(), &[ia]).await;
    assert_eq!(b2.inbox().await.len(), 1);
}

// ---------------------------------------------------------------- P1 #3

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn p1_3_second_engine_on_same_state_dir_is_refused_until_shutdown() {
    let d = tempdir().unwrap();
    let e1 = start(d.path(), &[]).await;
    let err = PeerEngine::start(config(d.path(), &[])).await.err().expect("second writer must fail");
    assert!(err.to_string().contains("already holds"), "{err:#}");
    e1.shutdown().await;
    let e2 = start(d.path(), &[]).await;
    e2.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn p1_3_live_ipc_socket_is_not_unlinked_but_stale_one_is() {
    let d = tempdir().unwrap();
    let e = start(d.path(), &[]).await;
    let ipc_dir = d.path().join("ipc");
    std::fs::create_dir_all(&ipc_dir).unwrap();
    let sock = ipc_dir.join("peer-engine.sock");
    let live = std::os::unix::net::UnixListener::bind(&sock).unwrap();
    let err = IpcServer::bind(e.clone()).await.err().expect("must refuse live socket");
    assert!(err.to_string().contains("already serving"), "{err:#}");
    assert!(sock.exists());
    drop(live); // leaves a stale socket file behind
    assert!(sock.exists());
    let server = IpcServer::bind(e.clone()).await.expect("stale socket replaced");
    assert_eq!(server.socket_path(), sock.as_path());
}

// ---------------------------------------------------------------- P1 #4

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn p1_4_inbox_is_paginated_and_ackable_over_1mib() {
    let (da, db) = (tempdir().unwrap(), tempdir().unwrap());
    let (ia, ib) = (id_of(da.path()), id_of(db.path()));
    let a = start(da.path(), &[ib]).await;
    let b = start(db.path(), &[ia]).await;
    let big = "x".repeat(250 * 1024);
    for i in 0..5 {
        a.send_message(b.endpoint_addr(), format!("big{i}"), big.clone()).await.unwrap();
    }
    // Worst-case escaping: one max-size payload of control chars still fits in a page.
    a.send_message(b.endpoint_addr(), "ctl", "\u{1}".repeat(40 * 1024)).await.unwrap();

    let ipc = IpcServer::bind(b.clone()).await.unwrap();
    let sock = ipc.socket_path().to_path_buf();
    tokio::spawn(async move { let _ = ipc.serve().await; });
    let mut cl = IpcClient::connect(&sock).await.unwrap();
    cl.call("hello", serde_json::json!({})).await.unwrap();

    let mut after = 0u64;
    let mut seen = Vec::new();
    let mut pages = 0;
    loop {
        let page = cl.call("inbox", serde_json::json!({"after_seq": after, "limit": 50})).await.expect("page");
        pages += 1;
        for it in page["items"].as_array().unwrap() {
            seen.push((it["from_endpoint_id"].as_str().unwrap().to_string(), it["message_id"].as_str().unwrap().to_string()));
        }
        after = page["next_after_seq"].as_u64().unwrap();
        if !page["has_more"].as_bool().unwrap() {
            break;
        }
    }
    assert_eq!(seen.len(), 6);
    assert!(pages >= 2, "expected multiple pages, got {pages}");

    let items: Vec<_> = seen
        .iter()
        .map(|(f, m)| serde_json::json!({"from_endpoint_id": f, "message_id": m}))
        .collect();
    let ack = cl.call("ack", serde_json::json!({"items": items})).await.unwrap();
    assert_eq!(ack["acked"], 6);
    let again = cl.call("ack", serde_json::json!({"items": items[..1]})).await.unwrap();
    assert_eq!(again["already_acked"], 1);
    let empty = cl.call("inbox", serde_json::json!({})).await.unwrap();
    assert_eq!(empty["items"].as_array().unwrap().len(), 0);
    // Acked items stay deduplicated.
    let r = a.send_message(b.endpoint_addr(), "big0", big.clone()).await.unwrap();
    assert!(r.duplicate);
    assert_eq!(b.inbox().await.len(), 0);
}

// ---------------------------------------------------------------- P1 #5

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn p1_5_non_member_is_rejected_before_any_frame() {
    let (da, db) = (tempdir().unwrap(), tempdir().unwrap());
    let ib = id_of(db.path());
    let a = start(da.path(), &[ib]).await;
    let b = start(db.path(), &[]).await; // A not on B's roster
    let err = a.send_message(b.endpoint_addr(), "m", "hi").await.unwrap_err();
    assert!(matches!(err, DeliveryError::Pending(_)), "{err:?}");
    assert_eq!(b.inbox().await.len(), 0);
    assert_eq!(outbound_state(&a, "m").await.as_deref(), Some("queued_local"));

    // Raw endpoint: connection is closed with not_member; no frame is read.
    let raw = raw_endpoint().await;
    let conn = raw.connect(b.endpoint_addr(), ALPN).await.unwrap();
    let res = async {
        let (mut s, mut r) = conn.open_bi().await?;
        let msg = PeerMessage::new("raw", "hi", raw.id().to_string())?;
        write_envelope(&mut s, &WireEnvelope::Message(msg)).await?;
        s.finish()?;
        read_envelope(&mut r).await
    }
    .await;
    assert!(res.is_err(), "non-member got a reply: {res:?}");
    assert_eq!(b.inbox().await.len(), 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn p1_5_wrong_key_cannot_impersonate_member() {
    let (da, db) = (tempdir().unwrap(), tempdir().unwrap());
    let (ia, ib) = (id_of(da.path()), id_of(db.path()));
    let b = start(db.path(), &[ia]).await;

    // (a) Sender dials B's address but expects a different key: TLS identity
    // check fails, nothing is settled.
    let a = start(da.path(), &[ib]).await;
    let mut wrong = b.endpoint_addr();
    wrong.id = SecretKey::generate().public();
    let err = a.send_message(wrong, "w", "hi").await.unwrap_err();
    assert!(matches!(err, DeliveryError::Pending(_)), "{err:?}");
    assert_eq!(outbound_state(&a, "w").await.as_deref(), Some("queued_local"));

    // (b) A different key claiming to be A in the message body: rejected as
    // a non-member at the connection layer (roster holds A's key only).
    let raw = raw_endpoint().await;
    let conn = raw.connect(b.endpoint_addr(), ALPN).await.unwrap();
    let res = async {
        let (mut s, mut r) = conn.open_bi().await?;
        let msg = PeerMessage::new("spoof", "hi", ia.to_string())?;
        write_envelope(&mut s, &WireEnvelope::Message(msg)).await?;
        s.finish()?;
        read_envelope(&mut r).await
    }
    .await;
    assert!(res.is_err(), "impersonator got a reply: {res:?}");

    // (c) Even a member cannot claim another sender id in the body.
    b.allow_peer(raw.id());
    let conn = raw.connect(b.endpoint_addr(), ALPN).await.unwrap();
    let (mut s, mut r) = conn.open_bi().await.unwrap();
    let msg = PeerMessage::new("spoof2", "hi", ia.to_string()).unwrap();
    write_envelope(&mut s, &WireEnvelope::Message(msg)).await.unwrap();
    s.finish().unwrap();
    match read_envelope(&mut r).await.unwrap() {
        WireEnvelope::Reject(rj) => assert_eq!(rj.code, "sender_mismatch"),
        other => panic!("expected reject, got {other:?}"),
    }
    assert_eq!(b.inbox().await.len(), 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn p1_5_per_peer_quota_then_retry_after_ack() {
    let (da, db) = (tempdir().unwrap(), tempdir().unwrap());
    let (ia, ib) = (id_of(da.path()), id_of(db.path()));
    let a = start(da.path(), &[ib]).await;
    let mut cb = config(db.path(), &[ia]);
    cb.limits.max_unconsumed_per_peer = 1;
    let b = PeerEngine::start(cb).await.unwrap();

    a.send_message(b.endpoint_addr(), "q1", "one").await.unwrap();
    let err = a.send_message(b.endpoint_addr(), "q2", "two").await.unwrap_err();
    assert!(matches!(err, DeliveryError::Pending(ref m) if m.contains("quota_exceeded")), "{err:?}");
    assert_eq!(b.inbox().await.len(), 1);

    b.consume(&ia.to_string(), "q1").await.unwrap();
    assert!(
        wait_until(Duration::from_secs(10), || async {
            outbound_state(&a, "q2").await.as_deref() == Some("settled")
        })
        .await,
        "retry loop did not deliver q2 after quota freed"
    );
    assert_eq!(b.inbox().await[0].message_id, "q2");
}

// ---------------------------------------------------------------- P2 #6

async fn fake_receiver(tamper: impl Fn(&mut PeerReceipt) + Send + 'static) -> (iroh::Endpoint, EndpointAddr) {
    let ep = raw_endpoint().await;
    let addr = ep.addr();
    let ep2 = ep.clone();
    tokio::spawn(async move {
        while let Some(inc) = ep2.accept().await {
            let Ok(conn) = inc.await else { continue };
            let Ok((mut s, mut r)) = conn.accept_bi().await else { continue };
            if let Ok(WireEnvelope::Message(m)) = read_envelope(&mut r).await {
                let mut rc = PeerReceipt::for_message(&m, ep2.id().to_string(), false);
                tamper(&mut rc);
                let _ = write_envelope(&mut s, &WireEnvelope::Receipt(rc)).await;
                let _ = s.finish();
                let _ = tokio::time::timeout(Duration::from_secs(2), conn.closed()).await;
            }
        }
    });
    (ep, addr)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn p2_6_receipt_with_wrong_hash_or_receiver_is_not_settled() {
    let da = tempdir().unwrap();
    let a = start(da.path(), &[]).await;

    let (_ep1, addr1) = fake_receiver(|r| r.payload_hash = "00".repeat(32)).await;
    let err = a.send_message(addr1, "h", "payload").await.unwrap_err();
    assert!(matches!(err, DeliveryError::Refused { ref code, .. } if code == "invalid_receipt"), "{err:?}");
    assert_eq!(outbound_state(&a, "h").await.as_deref(), Some("refused"));

    let other = SecretKey::generate().public().to_string();
    let (_ep2, addr2) = fake_receiver(move |r| r.receiver_endpoint_id = other.clone()).await;
    let err = a.send_message(addr2, "r", "payload").await.unwrap_err();
    assert!(matches!(err, DeliveryError::Refused { ref code, .. } if code == "invalid_receipt"), "{err:?}");
    assert_eq!(outbound_state(&a, "r").await.as_deref(), Some("refused"));

    let (_ep3, addr3) = fake_receiver(|_| {}).await;
    a.send_message(addr3, "ok", "payload").await.expect("honest receipt settles");
    assert_eq!(outbound_state(&a, "ok").await.as_deref(), Some("settled"));
}

// ---------------------------------------------------------------- P2 #7

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn p2_7_unsendable_encoded_frame_is_rejected_before_journaling() {
    let (da, db) = (tempdir().unwrap(), tempdir().unwrap());
    let ib = id_of(db.path());
    let a = start(da.path(), &[ib]).await;
    let b = start(db.path(), &[]).await;
    let err = a.send_message(b.endpoint_addr(), "nl", "\n".repeat(200 * 1024)).await.unwrap_err();
    assert!(matches!(err, DeliveryError::Invalid(_)), "{err:?}");
    let j = std::fs::read_to_string(da.path().join("journal/peer.jsonl")).unwrap();
    assert!(!j.contains("queued_local"));
    assert!(a.outbound_status("nl").await.is_none());
}

// ---------------------------------------------------------------- P2 #9

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn p2_9_start_does_not_hang_when_relay_is_unreachable() {
    let d = tempdir().unwrap();
    let mut c = EngineConfig::new(d.path());
    c.relay = RelayPreference::Custom(vec!["http://127.0.0.1:9/".parse().unwrap()]);
    c.online_timeout = Duration::from_millis(500);
    let t0 = Instant::now();
    let e = tokio::time::timeout(Duration::from_secs(15), PeerEngine::start(c))
        .await
        .expect("start must not hang on online()")
        .unwrap();
    assert!(t0.elapsed() < Duration::from_secs(15));
    assert_eq!(e.relay_online(), Some(false));
    e.shutdown().await;
}

// ---------------------------------------------------------------- P2 #11

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn p2_11_retry_with_backoff_delivers_after_admission() {
    let (da, db) = (tempdir().unwrap(), tempdir().unwrap());
    let (ia, ib) = (id_of(da.path()), id_of(db.path()));
    let a = start(da.path(), &[ib]).await;
    let b = start(db.path(), &[]).await;
    assert!(matches!(a.send_message(b.endpoint_addr(), "r1", "later").await, Err(DeliveryError::Pending(_))));
    assert!(wait_until(Duration::from_secs(5), || async {
        a.outbound_status("r1").await.map(|s| s.attempts >= 2).unwrap_or(false)
    }).await, "no retries happened");
    b.allow_peer(ia);
    assert!(wait_until(Duration::from_secs(10), || async {
        outbound_state(&a, "r1").await.as_deref() == Some("settled")
    }).await, "retry never settled");
    assert_eq!(b.inbox().await.len(), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn p2_11_unsettled_message_expires_and_stays_terminal() {
    let (da, db) = (tempdir().unwrap(), tempdir().unwrap());
    let ib = id_of(db.path());
    let mut ca = config(da.path(), &[ib]);
    ca.retry = RetryPolicy { expiry: Duration::from_millis(400), ..common::fast_retry() };
    let a = PeerEngine::start(ca).await.unwrap();
    let b = start(db.path(), &[]).await;
    let _ = a.send_message(b.endpoint_addr(), "e1", "never").await;
    assert!(wait_until(Duration::from_secs(5), || async {
        outbound_state(&a, "e1").await.as_deref() == Some("expired")
    }).await, "message never expired");
    let err = a.send_message(b.endpoint_addr(), "e1", "never").await.unwrap_err();
    assert!(matches!(err, DeliveryError::Terminal(_)), "{err:?}");
    assert_eq!(b.inbox().await.len(), 0);
    // Expiry is durable across restart.
    a.shutdown().await;
    let a2 = PeerEngine::start(config(da.path(), &[ib])).await.unwrap();
    assert_eq!(outbound_state(&a2, "e1").await.as_deref(), Some("expired"));
}

// ---------------------------------------------------------------- Codex fix-round 2

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fix_r2_clone_surviving_shutdown_cannot_write_journal() {
    let (da, db) = (tempdir().unwrap(), tempdir().unwrap());
    let (ia, ib) = (id_of(da.path()), id_of(db.path()));
    let a = start(da.path(), &[ib]).await;
    let b = start(db.path(), &[ia]).await;
    a.send_message(b.endpoint_addr(), "m1", "hi").await.unwrap();
    let survivor = b.clone();
    b.shutdown().await;
    let journal = db.path().join("journal/peer.jsonl");
    let before = std::fs::read(&journal).unwrap();
    assert!(survivor.consume(&ia.to_string(), "m1").await.is_err());
    assert!(survivor.send_message(a.endpoint_addr(), "x", "y").await.is_err());
    assert_eq!(std::fs::read(&journal).unwrap(), before, "closed engine wrote to the journal");
    let b2 = start(db.path(), &[ia]).await;
    assert_eq!(b2.inbox().await.len(), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fix_r2_ack_batch_is_validated_before_consuming() {
    let (da, db) = (tempdir().unwrap(), tempdir().unwrap());
    let (ia, ib) = (id_of(da.path()), id_of(db.path()));
    let a = start(da.path(), &[ib]).await;
    let b = start(db.path(), &[ia]).await;
    a.send_message(b.endpoint_addr(), "m1", "hi").await.unwrap();
    let ipc = IpcServer::bind(b.clone()).await.unwrap();
    let sock = ipc.socket_path().to_path_buf();
    tokio::spawn(async move { let _ = ipc.serve().await; });
    let mut cl = IpcClient::connect(&sock).await.unwrap();
    cl.call("hello", serde_json::json!({})).await.unwrap();
    let err = cl
        .call("ack", serde_json::json!({"items": [
            {"from_endpoint_id": ia.to_string(), "message_id": "m1"},
            {"message_id": "broken"}
        ]}))
        .await
        .unwrap_err();
    assert!(err.to_string().contains("invalid_params"));
    assert_eq!(b.inbox().await.len(), 1, "valid item was consumed despite batch error");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fix_r2_oversized_message_id_rejected_both_sides() {
    let (da, db) = (tempdir().unwrap(), tempdir().unwrap());
    let (ia, ib) = (id_of(da.path()), id_of(db.path()));
    let a = start(da.path(), &[ib]).await;
    let b = start(db.path(), &[ia]).await;
    let long = "m".repeat(257);
    assert!(matches!(a.send_message(b.endpoint_addr(), long.clone(), "x").await, Err(DeliveryError::Invalid(_))));
    // Raw member bypassing the sender check is refused by the receiver.
    let raw = raw_endpoint().await;
    b.allow_peer(raw.id());
    let conn = raw.connect(b.endpoint_addr(), ALPN).await.unwrap();
    let (mut s, mut r) = conn.open_bi().await.unwrap();
    let msg = PeerMessage::new(long, "x", raw.id().to_string()).unwrap();
    write_envelope(&mut s, &WireEnvelope::Message(msg)).await.unwrap();
    s.finish().unwrap();
    match read_envelope(&mut r).await.unwrap() {
        WireEnvelope::Reject(rj) => assert_eq!(rj.code, "invalid_message_id"),
        other => panic!("expected reject, got {other:?}"),
    }
}
