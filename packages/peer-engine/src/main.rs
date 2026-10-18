//! `peer-engine` daemon binary.
//!
//! Starts the iroh peer connectivity engine and serves the versioned Unix IPC
//! contract for a future Node supervisor/broker.
//!
//! This process never accepts MESH credentials and does not launch runtime drains.

use std::env;
use std::path::PathBuf;

use anyhow::{bail, Context, Result};
use peer_engine::{EngineConfig, IpcServer, PeerEngine, RelayPreference};
use tracing_subscriber::EnvFilter;

struct Args {
    state_dir: PathBuf,
    relay: RelayPreference,
}

impl Args {
    fn parse() -> Result<Self> {
        let mut state_dir = None;
        let mut relay = RelayPreference::DefaultRelays;
        let mut args = env::args().skip(1);
        while let Some(arg) = args.next() {
            match arg.as_str() {
                "--state-dir" => {
                    let value = args
                        .next()
                        .ok_or_else(|| anyhow::anyhow!("missing value for --state-dir"))?;
                    state_dir = Some(PathBuf::from(value));
                }
                "--direct-only" => relay = RelayPreference::DirectOnly,
                "--help" | "-h" => {
                    print_help();
                    std::process::exit(0);
                }
                other => bail!("unknown argument: {other}"),
            }
        }
        let state_dir = state_dir.unwrap_or_else(default_state_dir);
        Ok(Self { state_dir, relay })
    }
}

fn print_help() {
    eprintln!(
        "peer-engine — Triangle peer connectivity engine\n\n\
         USAGE:\n\
           peer-engine --state-dir <path> [--direct-only]\n\n\
         OPTIONS:\n\
           --state-dir <path>   Private state directory (0700); identity, journal, ipc socket\n\
           --direct-only         Disable iroh relays (local/LAN tests)\n\
           -h, --help            Show this help\n\n\
         This process does not accept MESH bearers or workload keys."
    );
}

fn default_state_dir() -> PathBuf {
    if let Ok(home) = env::var("HOME") {
        return PathBuf::from(home).join(".triangle").join("peer-engine");
    }
    PathBuf::from("/tmp/triangle-peer-engine")
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env().add_directive("peer_engine=info".parse()?))
        .init();

    let args = Args::parse()?;
    let mut config = EngineConfig::new(args.state_dir);
    if args.relay == RelayPreference::DirectOnly {
        config = config.direct_only();
    }

    let engine = PeerEngine::start(config)
        .await
        .context("start peer engine")?;
    let ipc = IpcServer::bind(engine.clone())
        .await
        .context("bind ipc")?;
    eprintln!(
        "peer-engine ready endpoint_id={} ipc={}",
        engine.endpoint_id_hex(),
        ipc.socket_path().display()
    );

    tokio::select! {
        res = ipc.serve() => res?,
        _ = tokio::signal::ctrl_c() => {
            tracing::info!("ctrl-c received, shutting down");
        }
    }
    engine.shutdown().await;
    Ok(())
}
