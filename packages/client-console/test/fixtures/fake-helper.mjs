#!/usr/bin/env node
/**
 * Fake triangle-mailbox / triangle-client for Linux CI.
 * Emits only secret-free operator JSON. Never prints mesh_ tokens.
 *
 * Dispatched by basename of argv[1] when invoked as:
 *   node fake-helper.mjs <role> <args...>
 * or via symlink/wrapper scripts in tests.
 */

const role = process.argv[2];
const args = process.argv.slice(3);

function write(obj, code = 0) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
  process.exit(code);
}

function flag(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

switch (role) {
  case "mailbox": {
    const command = args[0];
    if (command === "status") {
      const profile = flag("--profile") ?? "unknown";
      write(
        {
          profile,
          origin: "https://thetriangle.dev",
          agentId: "agent_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          handle: profile,
          lifecycle: "verified",
          verificationTimestamp: "2026-09-12T00:00:00.000Z",
          operatorAction: "none",
        },
        0,
      );
    }
    if (command === "watch-status" || command === "watch-ensure") {
      const installationId = flag("--installation");
      write(
        {
          installationId,
          origin: "https://thetriangle.dev",
          grantId: "grant_test",
          agentIds: ["agent_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
          state: command === "watch-ensure" ? "finalized" : "missing",
          audience: "wake",
          purpose: "mailbox-wake",
          memberCount: 1,
          listenerReady: command === "watch-ensure",
          operatorAction: command === "watch-ensure" ? "none" : "ensure_watch_grant",
        },
        command === "watch-ensure" ? 0 : 1,
      );
    }
    if (command === "enroll") {
      write(
        {
          profile: flag("--profile"),
          origin: flag("--origin"),
          agentId: "agent_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          handle: flag("--profile"),
          lifecycle: "verified",
          verificationTimestamp: "2026-09-12T00:00:00.000Z",
          operatorAction: "none",
        },
        0,
      );
    }
    write({ error: "unsupported" }, 2);
    break;
  }
  case "client": {
    if (args[0] === "agent" && args[1] === "list") {
      write({
        version: 1,
        operation: "listed",
        agents: [
          {
            profile: "research",
            instanceId: "a".repeat(64),
            runtimeAdapter: "codex",
            enabled: true,
            deliveryMode: "event-driven",
          },
        ],
      });
    }
    write({ error: "unsupported" }, 2);
    break;
  }
  case "service": {
    process.stdout.write("dev.thetriangle.client: fake-status running\n");
    process.exit(0);
    break;
  }
  case "leak": {
    // Intentionally bad fixture for negative tests only.
    write({ profile: "x", token: `mesh_${"c".repeat(64)}` }, 0);
    break;
  }
  default:
    process.stderr.write("usage: fake-helper.mjs <mailbox|client|service|leak> ...\n");
    process.exit(64);
}
