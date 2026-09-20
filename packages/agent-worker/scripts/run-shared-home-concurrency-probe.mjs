#!/usr/bin/env node
/**
 * Run the Phase 0 shared-home concurrency probe.
 *
 * Default: synthetic live-like fake (no ChatGPT.app).
 * Mini Darwin live:
 *   CODEX_BIN=/Applications/ChatGPT.app/Contents/Resources/codex \
 *     node packages/agent-worker/scripts/run-shared-home-concurrency-probe.mjs --live
 *
 * Never falls back to ~/.codex. Does not mutate runtime-manifest.json.
 */

import { writeFileSync } from "node:fs";
import path from "node:path";

import {
  runSharedHomeConcurrencyProbe,
  writeProbeReport,
} from "../src/codex-runtime/shared-home-concurrency-probe.mjs";
import { defaultTriangleCodexHome } from "../src/codex-runtime/runtime-home.mjs";

function parseArgs(argv) {
  const out = {
    live: false,
    command: process.env.CODEX_BIN ?? process.env.CODEX_CLI ?? null,
    args: ["app-server"],
    codexHome: process.env.TRIANGLE_CODEX_HOME ?? null,
    reportPath: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--live") {
      out.live = true;
    } else if (arg === "--command" && next) {
      out.command = next;
      i += 1;
    } else if (arg === "--codex-home" && next) {
      out.codexHome = next;
      i += 1;
    } else if (arg === "--report" && next) {
      out.reportPath = path.resolve(next);
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      out.help = true;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(`Usage:
  node run-shared-home-concurrency-probe.mjs [--live] [--command PATH] [--codex-home PATH] [--report FILE]

Environment:
  CODEX_BIN / CODEX_CLI   bundled codex binary (required with --live)
  TRIANGLE_CODEX_HOME     dedicated Triangle runtime home (optional)

Never uses ~/.codex. Manifest status stays unproved until Mini promotes it.
`);
  process.exit(0);
}

if (args.live && !args.command) {
  console.error("live probe requires --command or CODEX_BIN");
  process.exit(2);
}

const report = await runSharedHomeConcurrencyProbe({
  live: args.live,
  command: args.live ? args.command : null,
  args: args.live ? args.args : null,
  codexHome: args.codexHome ?? undefined,
});

const file = writeProbeReport(report);
if (args.reportPath) {
  writeFileSync(args.reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
}

const summary = {
  status: report.status,
  live: report.live,
  codexHome: report.codexHome ?? defaultTriangleCodexHome(),
  threads: report.threads,
  seedTurnIds: report.seedTurnIds,
  error: report.error,
  reportFile: file,
  reportCopy: args.reportPath,
  note: report.note ?? null,
  recovery: report.recovery ?? null,
  manifestPromotion: "Do not set sharedHomeConcurrency.status=passed unless status===passed on Mini live.",
};

console.log(JSON.stringify(summary, null, 2));
process.exit(report.status === "passed" || report.status === "synthetic-passed" ? 0 : 1);
