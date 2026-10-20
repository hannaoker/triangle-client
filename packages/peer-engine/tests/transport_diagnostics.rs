use peer_engine::{EngineConfig, PeerEngine, IpcServer};
use peer_engine::ipc::IpcClient;
use tempfile::tempdir;
#[tokio::test(flavor="multi_thread", worker_threads=2)]
async fn direct_receipt_records_observed_paths_not_advertised_candidates() {
 let a=tempdir().unwrap(); let b=tempdir().unwrap();
 let ea=PeerEngine::start(EngineConfig::new(a.path()).direct_only()).await.unwrap();
 let eb=PeerEngine::start(EngineConfig::new(b.path()).direct_only().allow_peer(ea.endpoint_id())).await.unwrap();
 assert_eq!(ea.transport_policy(),"direct_only");
 assert!(ea.transport_diagnostics().is_empty());
 ea.send_message(eb.endpoint_addr(),"path-proof","bounded diagnostic").await.unwrap();
 let samples=ea.transport_diagnostics();
 let final_sample=samples.last().unwrap();
 assert_eq!(final_sample["peer_endpoint_id"],eb.endpoint_id_hex());
 assert_eq!(final_sample["message_id"],"path-proof");
 assert_eq!(final_sample["phase"],"response_received");
 let paths=final_sample["paths"].as_array().unwrap();
 assert!(paths.iter().any(|p|p["selected"]==true&&p["kind"]=="direct"&&p["rx_bytes"].as_u64().unwrap()>0));
 let ipc=IpcServer::bind(ea.clone()).await.unwrap();
 let socket=ipc.socket_path().to_owned();let server=tokio::spawn(ipc.serve());
 let mut client=IpcClient::connect(socket).await.unwrap();
 client.call("hello",serde_json::json!({})).await.unwrap();
 let diagnostics=client.call("transport_diagnostics",serde_json::json!({})).await.unwrap();
 assert_eq!(diagnostics["samples"].as_array().unwrap().len(),samples.len());
 ea.shutdown().await; eb.shutdown().await;server.abort();
}
#[tokio::test]
async fn relay_only_has_no_ip_candidates() {
 let dir=tempdir().unwrap();let mut config=EngineConfig::new(dir.path());config.relay_only=true;config.online_timeout=std::time::Duration::from_millis(1);
 let engine=PeerEngine::start(config).await.unwrap();
 assert_eq!(engine.transport_policy(),"relay_only");
 assert!(engine.endpoint_addr().addrs.iter().all(|a|!a.is_ip()));
 engine.shutdown().await;
}
#[test]
fn conflicting_flags_and_credential_relay_urls_fail_before_state_creation() {
 for options in [vec!["--direct-only","--relay-only"],vec!["--relay-url","https://relay.example/","--direct-only"],vec!["--direct-only","--relay-url","https://relay.example/"],vec!["--relay-url","https://user:secret@relay.example/"],vec!["--relay-url","https://relay.example/?token=secret"]] {
  let dir=tempdir().unwrap();let state=dir.path().join("must-not-create");
  let result=std::process::Command::new(env!("CARGO_BIN_EXE_peer-engine")).arg("--state-dir").arg(&state).args(options).output().unwrap();
  assert!(!result.status.success());assert!(!state.exists());
 }
}
