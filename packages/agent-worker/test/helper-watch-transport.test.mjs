import assert from "node:assert/strict";
import test from "node:test";

import {
  createFakeWatchTransport,
  createHelperWatchTransport,
  createSharedWatchTransport,
  createInstallationWatchTransportFactory,
  ensureHelperWatchGrant,
} from "../src/helper-watch-transport.mjs";
import { createMemoryCursorStore, createWakeClient } from "../src/wake-client.mjs";

const id = (index) => index.toString(16).padStart(64, "0");

test("helper watch transport parses secret-free poll JSON", async () => {
  const calls = [];
  const transport = createHelperWatchTransport({
    helperPath: "/trusted/triangle-mailbox",
    installationId: "inst_N7VhDq3mQ2",
    async run(file, args) {
      calls.push({ file, args });
      return {
        code: 0,
        stdout: JSON.stringify({
          cursor: 5,
          events: [{ agent_id: "agent_a", high_watermark: 5 }],
        }),
        stderr: "",
      };
    },
  });

  const response = await transport.poll({ cursor: 2 });
  assert.deepEqual(calls[0], {
    file: "/trusted/triangle-mailbox",
    args: ["watch-poll", "--installation", "inst_N7VhDq3mQ2", "--cursor", "2"],
  });
  assert.deepEqual(response, {
    cursor: 5,
    events: [{ agent_id: "agent_a", high_watermark: 5 }],
  });
  assert.doesNotMatch(JSON.stringify(response), /mesh_watch_/);
});

test("helper watch transport maps resync exit 3 for wake-client", async () => {
  const transport = createHelperWatchTransport({
    helperPath: "/trusted/triangle-mailbox",
    installationId: "inst_N7VhDq3mQ2",
    async run() {
      return {
        code: 3,
        stdout: JSON.stringify({ error: "resync_required", restart_cursor: 40 }),
        stderr: "",
      };
    },
  });

  await assert.rejects(
    () => transport.poll({ cursor: 1 }),
    (error) => error.code === "resync_required" && error.restartCursor === 40,
  );
});

test("helper watch transport fails closed on helper failure", async () => {
  const transport = createHelperWatchTransport({
    helperPath: "/trusted/triangle-mailbox",
    installationId: "inst_N7VhDq3mQ2",
    async run() {
      return { code: 1, stdout: "", stderr: "operation failed" };
    },
  });
  await assert.rejects(() => transport.poll({ cursor: 0 }), (error) => error.code === "helper_unavailable");
});

test("helper watch transport attaches rejectedCode from watch_operation_failed stderr", async () => {
  const transport = createHelperWatchTransport({
    helperPath: "/trusted/triangle-mailbox",
    installationId: "inst_N7VhDq3mQ2",
    async run() {
      return {
        code: 1,
        stdout: "",
        stderr: JSON.stringify({
          status: "watch_operation_failed",
          code: "watch_rejected",
          gate: "network",
          operatorAction: "retry_later",
          safeToRetry: true,
          rejectedCode: "poll_limit_exceeded",
          rejectedStatusCode: 429,
        }) + "\n",
      };
    },
  });
  await assert.rejects(
    () => transport.poll({ cursor: 32 }),
    (error) =>
      error.code === "helper_unavailable"
      && error.rejectedCode === "poll_limit_exceeded"
      && error.failureCode === "watch_rejected"
      && error.diagnosis?.rejectedStatusCode === 429
      && /poll_limit_exceeded/.test(error.message),
  );
});

test("helper watch transport rejects invalid installation ids", () => {
  assert.throws(
    () => createHelperWatchTransport({ helperPath: "/trusted/triangle-mailbox", installationId: "inst_short" }),
    /installationId/,
  );
});

test("wake client integrates with helper watch transport adapter", async () => {
  const wakes = [];
  const transport = createHelperWatchTransport({
    helperPath: "/trusted/triangle-mailbox",
    installationId: "inst_N7VhDq3mQ2",
    async run(_file, args) {
      const cursor = Number(args.at(-1));
      return {
        code: 0,
        stdout: JSON.stringify({
          cursor: cursor + 3,
          events: [
            { agent_id: "agent_a", high_watermark: cursor + 3 },
            { agent_id: "agent_b", high_watermark: cursor + 2 },
          ],
        }),
        stderr: "",
      };
    },
  });
  const client = createWakeClient({
    profiles: [
      { instanceId: id(1), agentId: "agent_a" },
      { instanceId: id(2), agentId: "agent_b" },
    ],
    transport,
    cursorStore: createMemoryCursorStore(0),
    coalesceMs: 5,
    onWake: async (wake) => { wakes.push(wake); },
  });
  await client.runOnce();
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(await client.stop().then(() => true), true);
  assert.deepEqual(
    wakes.sort((left, right) => left.instanceId.localeCompare(right.instanceId)),
    [
      { instanceId: id(1), highWatermark: 3 },
      { instanceId: id(2), highWatermark: 2 },
    ],
  );
});

test("fake watch transport supports injected resync for unit tests", async () => {
  const transport = createFakeWatchTransport({
    polls: [
      { error: "resync_required", restart_cursor: 9 },
      { cursor: 9, events: [] },
    ],
  });
  await assert.rejects(
    () => transport.poll({ cursor: 0 }),
    (error) => error.code === "resync_required" && error.restartCursor === 9,
  );
  assert.deepEqual(await transport.poll({ cursor: 9 }), { cursor: 9, events: [] });
});

test("ensureHelperWatchGrant invokes watch-ensure and fails closed on non-zero exit", async () => {
  const calls = [];
  await ensureHelperWatchGrant({
    helperPath: "/trusted/triangle-mailbox",
    installationId: "inst_N7VhDq3mQ2",
    actorProfile: "event-hermes",
    async run(file, args) {
      calls.push({ file, args });
      return { code: 0, stdout: "{\"state\":\"finalized\"}\n", stderr: "" };
    },
  });
  assert.deepEqual(calls[0], {
    file: "/trusted/triangle-mailbox",
    args: ["watch-ensure", "--installation", "inst_N7VhDq3mQ2", "--actor-profile", "event-hermes"],
  });
  await assert.rejects(
    () => ensureHelperWatchGrant({
      helperPath: "/trusted/triangle-mailbox",
      installationId: "inst_N7VhDq3mQ2",
      actorProfile: "event-hermes",
      async run() { return { code: 1, stdout: "", stderr: "" }; },
    }),
    (error) => error.code === "helper_unavailable",
  );
  await assert.rejects(
    () => ensureHelperWatchGrant({
      helperPath: "/trusted/triangle-mailbox",
      installationId: "inst_N7VhDq3mQ2",
      actorProfile: "event-hermes",
      async run() {
        return {
          code: 1,
          stdout: "",
          stderr: JSON.stringify({
            status: "watch_operation_failed",
            code: "workload_key_missing",
            gate: "workload_auth",
            operatorAction: "repair_workload_auth",
            safeToRetry: false,
            mustNotReregister: true,
            detail: "Workload key material is missing for a watch grant member profile.",
            operatorNotes: [],
          }) + "\n",
        };
      },
    }),
    (error) =>
      error.code === "helper_unavailable"
      && error.failureCode === "workload_key_missing"
      && error.gate === "workload_auth"
      && error.operatorAction === "repair_workload_auth",
  );
});

test("ensureHelperWatchGrant retries credential_busy then succeeds", async () => {
  const calls = [];
  const result = await ensureHelperWatchGrant({
    helperPath: "/trusted/triangle-mailbox",
    installationId: "inst_N7VhDq3mQ2",
    actorProfile: "bob",
    busyRetryLimit: 3,
    async run(_file, args) {
      calls.push(args[0]);
      if (calls.length < 3) {
        return {
          code: 1,
          stdout: "",
          stderr: JSON.stringify({
            status: "watch_operation_failed",
            code: "credential_busy",
            gate: "profile",
            operatorAction: "retry_later",
            safeToRetry: true,
            mustNotReregister: true,
            detail: "Enrollment reservation is busy",
          }),
        };
      }
      return { code: 0, stdout: "{\"state\":\"finalized\"}\n", stderr: "" };
    },
  });
  assert.equal(result.ensured, true);
  assert.deepEqual(calls, ["watch-ensure", "watch-ensure", "watch-ensure"]);
});

test("ensureHelperWatchGrant fails closed after credential_busy retries exhaust", async () => {
  let attempts = 0;
  await assert.rejects(
    () => ensureHelperWatchGrant({
      helperPath: "/trusted/triangle-mailbox",
      installationId: "inst_N7VhDq3mQ2",
      actorProfile: "bob",
      busyRetryLimit: 2,
      async run() {
        attempts += 1;
        return {
          code: 1,
          stdout: "",
          stderr: JSON.stringify({
            status: "watch_operation_failed",
            code: "credential_busy",
            gate: "profile",
            operatorAction: "retry_later",
            safeToRetry: true,
            mustNotReregister: true,
            detail: "Enrollment reservation is busy",
          }),
        };
      },
    }),
    (error) => (
      error.code === "helper_unavailable"
      && error.failureCode === "credential_busy"
      && error.diagnosis?.safeToRetry === true
      && error.diagnosis?.code !== "journal_ineligible"
    ),
  );
  assert.equal(attempts, 2);
});

test("ensureHelperWatchGrant reuses existing grant only when poll probe succeeds", async () => {
  const calls = [];
  const result = await ensureHelperWatchGrant({
    helperPath: "/trusted/triangle-mailbox",
    installationId: "inst_N7VhDq3mQ2",
    actorProfile: "bob",
    async run(_file, args) {
      calls.push(args[0]);
      if (args[0] === "watch-ensure") {
        return {
          code: 1,
          stdout: "",
          stderr: JSON.stringify({
            status: "watch_operation_failed",
            code: "watch_rejected",
            gate: "network",
            operatorAction: "replace_watch_grant",
            safeToRetry: false,
            mustNotReregister: true,
            detail: "MESH rejected the local watch credential; discard the local watch binding and re-run watch-ensure without replacement.",
            rejectedCode: "replacement_unauthorized",
            rejectedStatusCode: 401,
            operatorNotes: [],
          }) + "\n",
        };
      }
      if (args[0] === "watch-poll") {
        return {
          code: 0,
          stdout: JSON.stringify({ cursor: 0, events: [] }) + "\n",
          stderr: "",
        };
      }
      return { code: 1, stdout: "", stderr: "unexpected" };
    },
  });
  assert.deepEqual(calls, ["watch-ensure", "watch-poll"]);
  assert.equal(result.ensured, true);
  assert.equal(result.reusedExisting, true);
});

test("ensureHelperWatchGrant fails closed when status would look ready but poll is credential-invalid", async () => {
  const calls = [];
  await assert.rejects(
    () => ensureHelperWatchGrant({
      helperPath: "/trusted/triangle-mailbox",
      installationId: "inst_N7VhDq3mQ2",
      actorProfile: "bob",
      async run(_file, args) {
        calls.push(args[0]);
        if (args[0] === "watch-ensure") {
          return {
            code: 1,
            stdout: "",
            stderr: JSON.stringify({
              status: "watch_operation_failed",
              code: "watch_rejected",
              gate: "network",
              operatorAction: "replace_watch_grant",
              safeToRetry: false,
              mustNotReregister: true,
              detail: "MESH rejected the local watch credential; discard the local watch binding and re-run watch-ensure without replacement.",
              rejectedCode: "replacement_unauthorized",
              rejectedStatusCode: 401,
              operatorNotes: [],
            }) + "\n",
          };
        }
        if (args[0] === "watch-status") {
          return {
            code: 0,
            stdout: JSON.stringify({
              installationId: "inst_N7VhDq3mQ2",
              state: "finalized",
              listenerReady: true,
              memberCount: 1,
            }) + "\n",
            stderr: "",
          };
        }
        if (args[0] === "watch-poll") {
          return {
            code: 1,
            stdout: "",
            stderr: JSON.stringify({
              status: "watch_operation_failed",
              code: "watch_rejected",
              gate: "network",
              operatorAction: "replace_watch_grant",
              safeToRetry: false,
              mustNotReregister: true,
              detail: "MESH rejected the local watch credential; discard the local watch binding and re-run watch-ensure without replacement.",
              rejectedCode: "watch_credential_invalid",
              rejectedStatusCode: 401,
              operatorNotes: [],
            }) + "\n",
          };
        }
        return { code: 1, stdout: "", stderr: "unexpected" };
      },
    }),
    (error) =>
      error.code === "helper_unavailable"
      && error.diagnosis?.rejectedCode === "watch_credential_invalid"
      && error.operatorAction === "replace_watch_grant"
      && !calls.includes("watch-status"),
  );
  assert.deepEqual(calls, ["watch-ensure", "watch-poll"]);
});

test("ensureHelperWatchGrant treats held-poll probe timeout as usable existing grant", async () => {
  const calls = [];
  const result = await ensureHelperWatchGrant({
    helperPath: "/trusted/triangle-mailbox",
    installationId: "inst_N7VhDq3mQ2",
    actorProfile: "bob",
    async run(_file, args) {
      calls.push(args[0]);
      if (args[0] === "watch-ensure") {
        return {
          code: 1,
          stdout: "",
          stderr: JSON.stringify({
            status: "watch_operation_failed",
            code: "watch_rejected",
            gate: "network",
            operatorAction: "replace_watch_grant",
            safeToRetry: false,
            mustNotReregister: true,
            detail: "MESH rejected the local watch credential.",
            rejectedCode: "replacement_unauthorized",
            rejectedStatusCode: 401,
            operatorNotes: [],
          }) + "\n",
        };
      }
      const error = new Error("watch helper timed out");
      error.code = "helper_unavailable";
      throw error;
    },
  });
  assert.deepEqual(calls, ["watch-ensure", "watch-poll"]);
  assert.equal(result.ensured, true);
  assert.equal(result.reusedExisting, true);
});

test("shared watch transport coalesces concurrent same-cursor polls", async () => {
  let underlyingPolls = 0;
  let releasePoll;
  const held = new Promise((resolve) => { releasePoll = resolve; });
  const underlying = {
    async poll({ cursor }) {
      underlyingPolls += 1;
      await held;
      return {
        cursor: cursor + 1,
        events: [
          { agent_id: "agent_a", high_watermark: cursor + 1 },
          { agent_id: "agent_b", high_watermark: cursor + 1 },
        ],
      };
    },
  };
  const shared = createSharedWatchTransport({ transport: underlying });
  const first = shared.poll({ cursor: 32 });
  const second = shared.poll({ cursor: 32 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(underlyingPolls, 1);
  releasePoll();
  const [left, right] = await Promise.all([first, second]);
  assert.equal(underlyingPolls, 1);
  assert.deepEqual(left, right);
  assert.equal(left.cursor, 33);
  assert.equal(left.events.length, 2);
});

test("shared watch transport serializes divergent cursors to one in-flight poll", async () => {
  const cursors = [];
  let active = 0;
  let peak = 0;
  const underlying = {
    async poll({ cursor }) {
      cursors.push(cursor);
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return { cursor: cursor + 5, events: [{ agent_id: "agent_a", high_watermark: cursor + 5 }] };
    },
  };
  const shared = createSharedWatchTransport({ transport: underlying });
  const [first, second] = await Promise.all([
    shared.poll({ cursor: 10 }),
    shared.poll({ cursor: 12 }),
  ]);
  assert.equal(peak, 1);
  assert.deepEqual(cursors, [10, 12]);
  assert.equal(first.cursor, 15);
  assert.equal(second.cursor, 17);
});

test("installation watch transport factory reuses one coalesced transport per installation", async () => {
  const created = [];
  const factory = createInstallationWatchTransportFactory(({ helperPath, installationId }) => {
    created.push({ helperPath, installationId });
    return {
      async poll({ cursor }) {
        return { cursor, events: [] };
      },
    };
  });
  const left = factory({
    helperPath: "/trusted/triangle-mailbox",
    installationId: "inst_EaA3qkuzOuQwTSFw",
  });
  const right = factory({
    helperPath: "/trusted/triangle-mailbox",
    installationId: "inst_EaA3qkuzOuQwTSFw",
  });
  assert.equal(left, right);
  assert.equal(created.length, 1);
  const other = factory({
    helperPath: "/trusted/triangle-mailbox",
    installationId: "inst_N7VhDq3mQ2",
  });
  assert.notEqual(other, left);
  assert.equal(created.length, 2);
});
