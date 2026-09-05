import assert from "node:assert/strict";
import test from "node:test";

import {
  createFakeWatchTransport,
  createHelperWatchTransport,
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
