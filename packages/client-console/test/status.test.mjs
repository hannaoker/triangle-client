import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectDashboard } from "../src/status.mjs";
import { formatDashboardHuman } from "../src/format.mjs";
import { findSecretLeak } from "../src/secrets.mjs";

const fixtures = path.dirname(fileURLToPath(import.meta.url));
const fakeHelper = path.join(fixtures, "fixtures", "fake-helper.mjs");

function runFake(file, args) {
  // Role is derived from the absolute path collectDashboard asks for.
  const base = path.basename(file);
  const role =
    base.includes("service") || file.includes("service.sh")
      ? "service"
      : base === "triangle-mailbox" || file.includes("triangle-mailbox")
        ? "mailbox"
        : base === "triangle-client" || file.includes("triangle-client")
          ? "client"
          : "mailbox";
  return import("node:child_process").then(
    ({ spawn }) =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [fakeHelper, role, ...args], {
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (c) => {
          stdout += c;
        });
        child.on("error", reject);
        child.on("close", (code) => resolve({ stdout, stderr: "", code }));
      }),
  );
}

test("collectDashboard aggregates secret-free status via fake helper", async () => {
  const home = "/tmp/triangle-console-test-home";
  const dashboard = await collectDashboard({
    home,
    installationId: "inst_N7VhDq3mQ2",
    serviceScriptPath: "/tmp/fake-triangle-client-service.sh",
    probe: async () => ({ present: true, executable: true, reason: "ok" }),
    run: runFake,
    readText: async () => {
      throw new Error("should not read installation when id supplied");
    },
  });

  assert.equal(dashboard.version, 1);
  assert.equal(dashboard.helper.present, true);
  assert.equal(dashboard.agents.length, 1);
  assert.equal(dashboard.agents[0].deliveryMode, "event-driven");
  assert.equal(dashboard.profiles[0].lifecycle, "verified");
  assert.equal(dashboard.watch.state, "missing");
  assert.equal(dashboard.watch.operatorAction, "ensure_watch_grant");
  assert.equal(dashboard.service.available, true);
  assert.match(dashboard.service.summary, /fake-status/);
  assert.equal(findSecretLeak(dashboard).ok, true);
  assert.doesNotMatch(JSON.stringify(dashboard), /mesh_/);
});

test("formatDashboardHuman stays secret-free", async () => {
  const dashboard = await collectDashboard({
    home: "/tmp/triangle-console-test-home",
    installationId: "inst_N7VhDq3mQ2",
    probe: async () => ({ present: true, executable: true, reason: "ok" }),
    run: runFake,
  });
  const text = formatDashboardHuman(dashboard);
  assert.match(text, /Helper \/ client binaries/);
  assert.match(text, /research/);
  assert.equal(findSecretLeak(text).ok, true);
});

test("collectDashboard records helper absence without throwing", async () => {
  const dashboard = await collectDashboard({
    home: "/tmp/triangle-console-test-home",
    probe: async () => ({ present: false, executable: false, reason: "missing" }),
    run: async () => {
      throw new Error("run should not be called");
    },
  });
  assert.equal(dashboard.helper.present, false);
  assert.ok(dashboard.errors.some((e) => e.code === "helper_unavailable"));
});

test("collectDashboard fails closed when helper leaks a token", async () => {
  const dashboard = await collectDashboard({
    home: "/tmp/triangle-console-test-home",
    installationId: "inst_N7VhDq3mQ2",
    probe: async () => ({ present: true, executable: true, reason: "ok" }),
    run: async (_file, args) => {
      if (args[0] === "agent") {
        return runFake("/x/triangle-client", args);
      }
      if (args[0] === "status") {
        return {
          stdout: JSON.stringify({
            profile: "research",
            token: `mesh_${"c".repeat(64)}`,
          }),
          stderr: "",
          code: 0,
        };
      }
      return runFake("/x/triangle-mailbox", args);
    },
  });
  assert.ok(dashboard.errors.some((e) => e.code === "secret_leak" || e.scope?.startsWith("profile_status")));
  assert.equal(dashboard.profiles.length, 0);
  assert.equal(findSecretLeak(dashboard).ok, true);
});
