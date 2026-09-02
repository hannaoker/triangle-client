import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { executeOutbound, main } from "../src/outbound-cli.mjs";

test("outbound CLI dispatches a normalized send operation", async () => {
  let received;
  const result = await executeOutbound(
    {
      operation: "send",
      recipientAgentId: "agent_peer",
      contextId: "context_1",
      text: "hello",
    },
    {
      async send(input) {
        received = input;
        return { task: { id: "task_1" } };
      },
    },
    () => "message_generated",
  );

  assert.deepEqual(received, {
    recipientAgentId: "agent_peer",
    messageId: "message_generated",
    contextId: "context_1",
    text: "hello",
  });
  assert.deepEqual(result, { task: { id: "task_1" } });
});

test("outbound CLI uses explicit environment selectors with mailbox-only worker configuration", async () => {
  let inputReads = 0;
  let clientOptions;
  let sent;
  let output = "";
  const result = await main(
    [
      "--gateway-url-env",
      "CODEX_OUTBOUND_GATEWAY_URL",
      "--internal-token-env",
      "CODEX_OUTBOUND_INTERNAL_TOKEN",
    ],
    {
      CODEX_OUTBOUND_GATEWAY_URL: "https://codex.example",
      CODEX_OUTBOUND_INTERNAL_TOKEN: "codex-internal-secret",
      MESH_ORIGIN: "https://mesh.example",
      MESH_AGENT_TOKEN: "mesh-mailbox-secret",
      CODEX_AGENT_ID: "agent_11111111111111111111111111111111",
    },
    {
      async readInput() {
        inputReads += 1;
        return {
          operation: "send",
          recipientAgentId: "agent_peer",
          messageId: "message_exact",
          text: "hello",
        };
      },
      createOutboundClient(options) {
        clientOptions = options;
        return {
          async send(input) {
            sent = input;
            return {
              task: {
                id: "task_1",
                contextId: "context_1",
                status: { state: "submitted" },
              },
            };
          },
        };
      },
      writeOutput(value) {
        output += value;
      },
    },
  );

  assert.equal(result, 0);
  assert.equal(inputReads, 1);
  assert.deepEqual(clientOptions, {
    gatewayUrl: "https://codex.example",
    internalToken: "codex-internal-secret",
  });
  assert.deepEqual(sent, {
    recipientAgentId: "agent_peer",
    messageId: "message_exact",
    text: "hello",
  });
  assert.doesNotMatch(output, /codex-internal-secret|mesh-mailbox-secret/);
});

test("outbound CLI rejects invalid selectors before reading input or creating a client", async () => {
  const cases = [
    [[], /--gateway-url-env <name> is required/],
    [["--gateway-url-env", "URL"], /--internal-token-env <name> is required/],
    [["--gateway-url-env", "URL", "--gateway-url-env", "OTHER", "--internal-token-env", "TOKEN"], /--gateway-url-env must be provided exactly once/],
    [["--gateway-url-env", "URL", "--internal-token-env", "TOKEN", "--config", "worker.json"], /Unknown argument: --config/],
    [["--gateway-url-env", "MESH_ORIGIN", "--internal-token-env", "MESH_AGENT_TOKEN"], /mailbox selectors are not allowed/],
    [["--gateway-url-env", "URL", "--internal-token-env", "URL"], /selectors must name distinct environment variables/],
  ];

  for (const [argv, expected] of cases) {
    let inputReads = 0;
    let clientCreates = 0;
    await assert.rejects(
      main(argv, { URL: "https://gateway.example", TOKEN: "secret" }, {
        async readInput() { inputReads += 1; },
        createOutboundClient() { clientCreates += 1; },
        writeOutput() {},
      }),
      expected,
    );
    assert.equal(inputReads, 0);
    assert.equal(clientCreates, 0);
  }
});

test("outbound CLI validates selected environment values before reading input or network", async () => {
  for (const env of [
    {},
    { OUTBOUND_URL: "https://gateway.example" },
    { OUTBOUND_TOKEN: "secret" },
    { OUTBOUND_URL: " ", OUTBOUND_TOKEN: "secret" },
  ]) {
    let inputReads = 0;
    let clientCreates = 0;
    await assert.rejects(
      main([
        "--gateway-url-env", "OUTBOUND_URL",
        "--internal-token-env", "OUTBOUND_TOKEN",
      ], env, {
        async readInput() { inputReads += 1; },
        createOutboundClient() { clientCreates += 1; },
        writeOutput() {},
      }),
      /OUTBOUND_(?:URL|TOKEN) is required/,
    );
    assert.equal(inputReads, 0);
    assert.equal(clientCreates, 0);
  }
});

test("Codex and Hermes package commands each send the exact fixture once beside mailbox-only configs", async () => {
  for (const agent of ["codex", "hermes"]) {
    const root = new URL(`../../../agents/${agent}/`, import.meta.url);
    const packageJson = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
    const mailboxConfig = JSON.parse(await readFile(new URL("worker/agent-worker.json", root), "utf8"));
    assert.equal(Object.hasOwn(mailboxConfig, "gateway"), false);
    assert.match(packageJson.scripts["agent-send"], /--gateway-url-env AGENT_ORIGIN --internal-token-env GATEWAY_INTERNAL_TOKEN$/);

    const fixture = {
      operation: "send",
      recipientAgentId: "agent_peer",
      messageId: `message_${agent}`,
      text: `hello from ${agent}`,
    };
    const sends = [];
    await main(
      ["--gateway-url-env", "AGENT_ORIGIN", "--internal-token-env", "GATEWAY_INTERNAL_TOKEN"],
      {
        AGENT_ORIGIN: `https://${agent}.example`,
        GATEWAY_INTERNAL_TOKEN: `${agent}-secret`,
        MESH_ORIGIN: "https://mesh.example",
        MESH_AGENT_TOKEN: "mailbox-secret",
      },
      {
        async readInput() { return fixture; },
        createOutboundClient(options) {
          assert.deepEqual(options, {
            gatewayUrl: `https://${agent}.example`,
            internalToken: `${agent}-secret`,
          });
          return {
            async send(input) {
              sends.push(input);
              return { task: { id: `task_${agent}` } };
            },
          };
        },
        writeOutput(value) {
          assert.doesNotMatch(value, /secret/);
        },
      },
    );
    assert.deepEqual(sends, [{
      recipientAgentId: fixture.recipientAgentId,
      messageId: fixture.messageId,
      text: fixture.text,
    }]);
  }
});
