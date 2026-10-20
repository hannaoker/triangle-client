//! `peer-engine` daemon binary.
//!
//! Starts the iroh peer connectivity engine and serves the versioned Unix IPC
//! contract for a future Node supervisor/broker.
//!
//! This process never accepts MESH credentials and does not launch runtime drains.

use std::env;
use std::path::PathBuf;

use anyhow::{bail, Context, Result};
use iroh::EndpointId;
use peer_engine::{EngineConfig, IpcServer, PeerEngine, RelayPreference};
use tracing_subscriber::EnvFilter;

struct Args {
    state_dir: PathBuf,
    relay: RelayPreference,
    relay_only: bool,
    allowed_peers: Vec<EndpointId>,
}

impl Args {
    fn parse() -> Result<Self> {
        let mut state_dir = None;
        let mut relay = RelayPreference::DefaultRelays;
        let mut allowed_peers = Vec::new();
        let mut relay_only = false;
        let mut args = env::args().skip(1);
        while let Some(arg) = args.next() {
            match arg.as_str() {
                "--state-dir" => {
                    let value = args
                        .next()
                        .ok_or_else(|| anyhow::anyhow!("missing value for --state-dir"))?;
                    state_dir = Some(PathBuf::from(value));
                }
                "--direct-only" => {
                    if matches!(relay, RelayPreference::Custom(_)) { bail!("--direct-only conflicts with --relay-url"); }
                    relay = RelayPreference::DirectOnly;
                },
                "--relay-only" => relay_only = true,
                "--relay-url" => {
                    let value = args.next().ok_or_else(|| anyhow::anyhow!("missing --relay-url value"))?;
                    if value.len() > 2048 { bail!("relay URL too long"); }
                    let url: iroh::RelayUrl = value.parse().context("invalid relay URL")?;
                    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() || url.query().is_some() || url.fragment().is_some() || url.path() != "/" { bail!("relay URL must be credential-free HTTPS"); }
                    match &mut relay { RelayPreference::Custom(urls) if urls.len() < 4 => urls.push(url), RelayPreference::DefaultRelays => relay = RelayPreference::Custom(vec![url]), _ => bail!("conflicting transport options or too many relays") }
                }
                "--allow-peer" => {
                    let value = args
                        .next()
                        .ok_or_else(|| anyhow::anyhow!("missing value for --allow-peer"))?;
                    allowed_peers.push(parse_peer(&value)?);
                }
                "--roster" => {
                    let value = args
                        .next()
                        .ok_or_else(|| anyhow::anyhow!("missing value for --roster"))?;
                    allowed_peers.extend(load_roster(&value)?);
                }
                "--help" | "-h" => {
                    print_help();
                    std::process::exit(0);
                }
                other => bail!("unknown argument: {other}"),
            }
        }
        // No implicit default: never create state under ~/.triangle by accident.
        let state_dir = state_dir.ok_or_else(|| anyhow::anyhow!("--state-dir <path> is required"))?;
        if relay_only && relay == RelayPreference::DirectOnly { bail!("--relay-only conflicts with --direct-only"); }
        Ok(Self { state_dir, relay, relay_only, allowed_peers })
    }
}

fn print_help() {
    eprintln!(
        "peer-engine — Triangle peer connectivity engine\n\n\
         USAGE:\n\
           peer-engine --state-dir <path> [--direct-only | --relay-only] [--relay-url HTTPS_URL] [--allow-peer <id>]... [--roster <file>]\n\n\
         OPTIONS:\n\
           --state-dir <path>   Private state directory (0700); identity, journal, ipc socket (required)\n\
           --direct-only         Disable iroh relays (local/LAN tests)\n\
           --relay-only          Disable all IP transports; relay traffic only\n\
           --relay-url <https>   Custom HTTPS relay origin (repeatable, at most 4)\n\
           --allow-peer <id>     Admit inbound messages from this endpoint id (repeatable)\n\
           --roster <file>       JSON file: {{\"peers\": [\"<endpoint-id>\", ...]}}\n\
         An empty roster admits nobody.\n\
           -h, --help            Show this help\n\n\
         This process does not accept MESH bearers or workload keys."
    );
}

fn parse_peer(value: &str) -> Result<EndpointId> {
    value
        .parse::<EndpointId>()
        .map_err(|e| anyhow::anyhow!("invalid endpoint id {value}: {e}"))
}

fn load_roster(path: &str) -> Result<Vec<EndpointId>> {
    #[derive(serde::Deserialize)]
    struct Roster {
        peers: Vec<String>,
    }
    let raw = std::fs::read_to_string(path).with_context(|| format!("read roster {path}"))?;
    let roster: Roster = serde_json::from_str(&raw).with_context(|| format!("parse roster {path}"))?;
    roster.peers.iter().map(|p| parse_peer(p)).collect()
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env().add_directive("peer_engine=info".parse()?))
        .init();

    let args = Args::parse()?;
    let mut config = EngineConfig::new(args.state_dir);
    config.allowed_peers = args.allowed_peers;
    config.relay = args.relay;
    config.relay_only = args.relay_only;

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
