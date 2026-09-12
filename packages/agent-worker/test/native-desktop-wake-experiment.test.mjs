import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:net";

import {
  SHARED_CODEX_ADAPTER_VERSION,
  createScriptedAuthHandshakeSocket,
} from "../src/shared-codex-app-server.mjs";
import {
  DESKTOP_EXPERIMENT_DEBUG_PORT,
  DESKTOP_EXPERIMENT_REPLY_MARKER,
  assertDebugPortFree,
  assertDesktopExperimentGuards,
  buildDesktopExperimentBinding,
  buildNonceWakeTurnText,
  createDesktopExperimentNonce,
  runNativeDesktopWakeListener,
} from "../src/native-desktop-wake-experiment.mjs";

const serverIdentity = "codex-app-server/desktop-experiment";
const authorization = "Bearer capability-token-for-desktop-tests";
const threadId = "01a06f9f-2db1-7143-b8b9-08c634cc7999";
const endpoint = "ws://127.0.0.1:9999/rpc";

function sampleEnv(overrides = {}) {
  return {
    MESH_ALLOW_DESKTOP_EXPERIMENT: "1",
    MESH_DESKTOP_TEST_ROOT: "/private/tmp/mesh-desktop-nonce-test",
    MESH_DESKTOP_TEST_THREAD_ID: threadId,
    MESH_DESKTOP_SERVER_IDENTITY: serverIdentity,
    MESH_DESKTOP_AUTH_TOKEN_FILE: "/private/tmp/mesh-desktop-nonce-test/ws.token",
    MESH_DESKTOP_AUTH_TOKEN_ENV: undefined,
    ...overrides,
  };
}

test("desktop experiment guards require opt-in, private root, thread, identity, and auth", () => {
  assert.throws(
    () => assertDesktopExperimentGuards({}),
    (error) => error.code === "desktop_experiment_opt_in_required",
  );
  assert.throws(
    () => assertDesktopExperimentGuards(sampleEnv({ MESH_DESKTOP_TEST_ROOT: "/tmp/not-private" })),
    (error) => error.code === "desktop_experiment_root_invalid",
  );
  assert.throws(
    () => assertDesktopExperimentGuards(sampleEnv({ MESH_DESKTOP_TEST_THREAD_ID: "short" })),
    (error) => error.code === "desktop_experiment_thread_invalid",
  );
  assert.throws(
    () => assertDesktopExperimentGuards(sampleEnv({
      MESH_DESKTOP_AUTH_TOKEN_FILE: undefined,
      MESH_DESKTOP_AUTH_TOKEN_ENV: undefined,
    })),
    (error) => error.code === "desktop_experiment_auth_invalid",
  );
  assert.throws(
    () => assertDesktopExperimentGuards(sampleEnv({
      MESH_DESKTOP_AUTH_TOKEN_FILE: "/private/tmp/a",
      MESH_DESKTOP_AUTH_TOKEN_ENV: "CODEX_TOKEN",
    })),
    (error) => error.code === "desktop_experiment_auth_invalid",
  );
  assert.throws(
    () => assertDesktopExperimentGuards(sampleEnv({ MESH_DESKTOP_SERVER_IDENTITY: "" })),
    (error) => error.code === "desktop_experiment_identity_invalid",
  );

  const ok = assertDesktopExperimentGuards(sampleEnv());
  assert.equal(ok.threadId, threadId);
  assert.equal(ok.debugPort, DESKTOP_EXPERIMENT_DEBUG_PORT);
  assert.equal(ok.authTokenFile, "/private/tmp/mesh-desktop-nonce-test/ws.token");
  assert.equal(ok.authTokenEnv, null);
});

test("nonce wake turn text embeds unique nonce and exact reply marker", () => {
  const nonce = createDesktopExperimentNonce(() => Buffer.from("aabbcc"));
  assert.match(nonce, /^NDW_/);
  const text = buildNonceWakeTurnText(nonce);
  assert.match(text, /createAuthenticatedAppServerTransport/);
  assert.match(text, /createSharedCodexSession/);
  assert.match(text, new RegExp(`Nonce ${nonce}`));
  assert.match(text, new RegExp(`${DESKTOP_EXPERIMENT_REPLY_MARKER} ${nonce}`));
  assert.match(text, /not Bob/);
  assert.throws(() => buildNonceWakeTurnText("bad\nnonce"), /nonce is invalid/);
});

test("binding builder validates production-shaped durable fields", () => {
  const binding = buildDesktopExperimentBinding({
    threadId,
    endpoint,
    serverIdentity,
  });
  assert.equal(binding.adapterVersion, SHARED_CODEX_ADAPTER_VERSION);
  assert.equal(binding.enabled, true);
  assert.equal(binding.threadId, threadId);
  assert.throws(
    () => buildDesktopExperimentBinding({
      threadId,
      endpoint: "http://not-ws",
      serverIdentity,
    }),
    /endpoint is invalid/,
  );
});

test("assertDebugPortFree fails closed when the fixed debug port is busy", async () => {
  const blocker = createServer();
  await new Promise((resolve) => blocker.listen(0, "127.0.0.1", resolve));
  const busyPort = blocker.address().port;
  await assert.rejects(
    () => assertDebugPortFree(busyPort),
    (error) => error.code === "desktop_experiment_debug_port_busy" && error.port === busyPort,
  );
  await new Promise((resolve) => blocker.close(resolve));
  await assertDebugPortFree(busyPort);
});

test("runNativeDesktopWakeListener uses authenticated transport + shared session", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "triangle-desktop-nonce-"));
  const tokenFile = path.join(root, "ws.token");
  await writeFile(tokenFile, "capability-token-for-desktop-tests\n", "utf8");

  const binding = buildDesktopExperimentBinding({
    threadId,
    endpoint,
    serverIdentity,
  });
  const nonce = "NDW_linux_unit_test_nonce01";
  const openSocket = createScriptedAuthHandshakeSocket({
    expectedAuthorization: authorization,
    serverIdentity,
    initializeResult: { userAgent: "codex_cli_rs/test" },
  });

  const evidence = await runNativeDesktopWakeListener({
    binding,
    nonce,
    tokenFile,
    awaitAuthenticatedHello: true,
    openSocket,
    waitTimeoutMs: 5_000,
    requestTimeoutMs: 5_000,
    logger: { log() {}, error() {} },
  });

  assert.equal(evidence.nonce, nonce);
  assert.equal(evidence.threadId, threadId);
  assert.equal(evidence.turnStatus, "completed");
  assert.match(evidence.turnId, /^turn_/);
  assert.match(evidence.turnText, new RegExp(nonce));
  assert.equal(evidence.sessionStatus, "subscribed");
});
