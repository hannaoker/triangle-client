import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeProfile, profilePath, linuxPaths } from "../src/paths.mjs";
import { openStore } from "../src/store.mjs";
import { runHost, loadHostConfig } from "../src/host.mjs";
function fixture(extra = {}) {
  const ac = new AbortController(),
    health = [],
    logs = [];
  let calls = [];
  const config = {
    profile: "codex",
    agentId: "agent_" + "a".repeat(32),
    stateRoot: "/private/tmp/host-test",
    pollIntervalMs: 1000,
  };
  const store = {
    writeHealth: (v) => health.push({ ...v }),
    close: () => calls.push("close"),
  };
  const args = {
    configPath: "/private/tmp/config",
    signal: ac.signal,
    loadConfigImpl: () => config,
    openStoreImpl: () => store,
    lockImpl: async (root, fn) => fn(),
    createTransportImpl: () => ({ verify: async () => calls.push("verify") }),
    createRunnerImpl: () => ({
      probe: async () => {
        calls.push("probe");
        return { ok: true };
      },
    }),
    createCustodianImpl: () => ({
      cycle: async () => {
        calls.push("cycle");
        return { state: "completed" };
      },
    }),
    sleepImpl: async () => ac.abort(),
    log: (s) => logs.push(s),
    ...extra,
  };
  return { ac, health, logs, calls, args };
}
test("readiness follows identity and sandbox probe and stops cleanly", async () => {
  const f = fixture();
  await runHost(f.args);
  assert.deepEqual(f.calls, ["verify", "probe", "cycle", "close"]);
  assert.equal(f.health[0].ready, false);
  assert.equal(f.health.find((h) => h.ready).verified, true);
  assert.equal(f.health.at(-1).state, "stopped");
  assert.equal(f.health.at(-1).ready, false);
  assert.equal(f.health.at(-2).completed, 1);
});
test("probe failure never publishes ready and logs contain no provider text", async () => {
  const f = fixture({
    createRunnerImpl: () => ({
      probe: async () => {
        throw Error("credential secret provider body");
      },
    }),
  });
  await assert.rejects(runHost(f.args), /runtime_failed/);
  assert.equal(
    f.health.some((h) => h.ready),
    false,
  );
  assert.equal(f.health.at(-1).state, "needs_attention");
  assert.doesNotMatch(f.logs.join("\n"), /credential|secret|provider|body/);
});
test("duplicate host lock does not open store or overwrite health", async () => {
  const f = fixture({
    lockImpl: () => {
      throw Error("Another triangle command is using lock");
    },
    openStoreImpl: () => {
      throw Error("must_not_open");
    },
  });
  await assert.rejects(runHost(f.args), /store_busy/);
  assert.equal(f.health.length, 0);
});
test("abort during probe never publishes readiness", async () => {
  const f = fixture();
  f.args.createRunnerImpl = () => ({
    probe: async () => {
      f.ac.abort();
      return { ok: true };
    },
  });
  await runHost(f.args);
  assert.equal(
    f.health.some((h) => h.ready),
    false,
  );
  assert.equal(f.health.at(-1).state, "stopped");
  assert.equal(f.calls.includes("cycle"), false);
});
test("cycle failure exposes only safe health code and retries", async () => {
  const f = fixture({
    createCustodianImpl: () => ({
      cycle: async () => {
        throw Error("private server response");
      },
    }),
  });
  await runHost(f.args);
  assert.equal(
    f.health.find((h) => h.state === "needs_attention").lastError,
    "runtime_failed",
  );
  assert.doesNotMatch(
    JSON.stringify(f.health) + f.logs.join(),
    /private server/,
  );
});
test("real agent host lock prevents second host from changing running health", async () => {
  const root = realpathSync(
    mkdtempSync(path.join(tmpdir(), "host-lock-test-")),
  );
  const first = fixture();
  let release, entered;
  const ready = new Promise((r) => (entered = r));
  first.args.openStoreImpl = openStore;
  delete first.args.lockImpl;
  first.args.loadConfigImpl = () => ({
    profile: "codex",
    agentId: "agent_" + "a".repeat(32),
    stateRoot: root,
    pollIntervalMs: 1000,
  });
  first.args.sleepImpl = () => {
    entered();
    return new Promise((r) => (release = r));
  };
  const running = runHost(first.args);
  await ready;
  const before = readFileSync(path.join(root, "health.json"), "utf8");
  const second = fixture();
  delete second.args.lockImpl;
  second.args.loadConfigImpl = first.args.loadConfigImpl;
  second.args.openStoreImpl = openStore;
  await assert.rejects(runHost(second.args), /store_busy/);
  assert.equal(readFileSync(path.join(root, "health.json"), "utf8"), before);
  first.ac.abort();
  release();
  await running;
});
test("heartbeat stays fresh while a model cycle is pending", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const f = fixture();
  let cycles = 0,
    entered;
  const cycleEntered = new Promise((resolve) => {
    entered = resolve;
  });
  f.args.heartbeatMs = 5;
  f.args.now = (() => {
    let n = 100;
    return () => ++n;
  })();
  f.args.createCustodianImpl = () => ({
    cycle: async ({ signal }) => {
      cycles++;
      await new Promise((resolve) => {
        signal.addEventListener("abort", resolve, { once: true });
        entered();
      });
      return { state: "idle" };
    },
  });
  const running = runHost(f.args);
  await cycleEntered;
  const initialReady = f.health.filter((h) => h.ready);
  assert.equal(initialReady.length, 1);
  // Advance recurring heartbeats while the cycle remains blocked on abort.
  t.mock.timers.tick(15);
  const refreshed = f.health.filter((h) => h.ready);
  assert.equal(refreshed.length, 4);
  assert.ok(refreshed.at(-1).updatedAt > initialReady[0].updatedAt);
  assert.equal(cycles, 1);
  f.ac.abort();
  await running;
  assert.equal(f.health.at(-1).state, "stopped");
});
test("host requires private canonical managed configuration", () => {
  const home = realpathSync(
      mkdtempSync(path.join(tmpdir(), "host-config-test-")),
    ),
    options = { accountHome: home, env: {} };
  const p = linuxPaths(options),
    agentId = "agent_" + "a".repeat(32);
  const config = {
    schema: 1,
    profile: "codex",
    agentId,
    identityHome: home + "/identity",
    authority: "https://mesh.test",
    via: null,
    harness: "codex",
    command: home + "/codex",
    bwrap: home + "/bwrap",
    node: home + "/release/bin/node",
    releaseRoot: home + "/release",
    workdir: home + "/workdir",
    modelHome: path.join(p.modelsRoot, "codex"),
    stateRoot: path.join(p.stateRoot, "agents", agentId),
    pollIntervalMs: 30000,
    runnerTimeoutMs: 600000,
  };
  writeProfile(config, options);
  const file = profilePath("codex", options);
  assert.deepEqual(loadHostConfig(file, options), config);
  chmodSync(file, 0o644);
  assert.throws(() => loadHostConfig(file, options));
});
