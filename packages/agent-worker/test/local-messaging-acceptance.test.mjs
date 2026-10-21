import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import {
  createTurnCapabilityIssuer,
} from "../src/local-messaging-credentials.mjs";

test("real separate-process Unix socket client/server acceptance with test SQLite persistence fixture", { skip: process.platform === "win32" }, async () => {
  const realTmp = fs.realpathSync(os.tmpdir());
  const tmpDir = fs.mkdtempSync(path.join(realTmp, "triangle-acceptance-"));
  fs.chmodSync(tmpDir, 0o700);
  const socketPath = path.join(tmpDir, "local-control.sock");
  const dbPath = path.join(tmpDir, "journal.sqlite");
  const secret = "acceptance-secret-32-chars-long-test-key!";

  const issuer = createTurnCapabilityIssuer({ secret });
  const codexToken = issuer.issue({ senderId: "desktop-codex" });

  // Server script executed in separate child process
  const serverScript = `
    import { createLocalControlServer } from "${new URL("../src/local-messaging-server.mjs", import.meta.url).href}";
    import { createTestSqliteJournal, createTestRecoverableDispatcher } from "${new URL("../test/local-messaging-fixtures.mjs", import.meta.url).href}";
    import { createOwnerAcl } from "${new URL("../src/local-messaging-acl.mjs", import.meta.url).href}";
    import { createTurnCapabilityValidator } from "${new URL("../src/local-messaging-credentials.mjs", import.meta.url).href}";
    import { createPerSenderRateLimiter, createConversationLoopTracker } from "${new URL("../src/local-messaging-rate-limiter.mjs", import.meta.url).href}";

    const journal = createTestSqliteJournal({ dbPath: "${dbPath}" });
    const acl = createOwnerAcl({ rules: { "desktop-codex": ["gravity2"] } });
    const validator = createTurnCapabilityValidator({ secret: "${secret}" });
    const rateLimiter = createPerSenderRateLimiter({ maxRequestsPerWindow: 20 });
    const loopTracker = createConversationLoopTracker({ maxLoopDepth: 5, journal });

    const dispatcher = createTestRecoverableDispatcher({
      journal,
      execute: async (job) => {
        // Injected mock runner: executes asynchronously and writes durable reply to SQLite journal
        setTimeout(async () => {
          await journal.recordReply({
            sender: job.recipient,
            recipient: job.sender,
            messageId: "reply-" + job.messageId,
            requestId: job.requestId,
            inReplyTo: job.messageId,
            text: "ECHO:" + job.text,
          });
        }, 100);
      },
    });

    const server = createLocalControlServer({
      socketPath: "${socketPath}",
      journal,
      acl,
      credentialValidator: validator,
      rateLimiter,
      loopTracker,
      dispatcher,
    });

    await server.start();
    console.log("SERVER_READY");

    process.on("SIGTERM", async () => {
      await server.close();
      await journal.close();
      process.exit(0);
    });
  `;

  // Start server process
  const serverProc = spawn("node", ["--input-type=module", "-e", serverScript], {
    stdio: ["ignore", "pipe", "inherit"],
  });

  try {
    // Wait for server ready
    await new Promise((resolve, reject) => {
      serverProc.stdout.on("data", (chunk) => {
        if (chunk.toString().includes("SERVER_READY")) resolve();
      });
      serverProc.on("error", reject);
      serverProc.on("exit", (code) => {
        if (code !== 0) reject(new Error("Server process exited with code " + code));
      });
    });

    // Client process 1: sends message and exits without consuming reply
    const clientScript1 = `
      import { createLocalControlClient } from "${new URL("../src/local-messaging-client.mjs", import.meta.url).href}";

      const client = createLocalControlClient({
        socketPath: "${socketPath}",
        turnCredential: "${codexToken}",
        senderId: "desktop-codex",
      });

      const recipients = await client.discoverRecipients();
      if (!recipients.includes("gravity2")) {
        console.error("Missing gravity2 recipient");
        process.exit(1);
      }

      const receipt = await client.sendMessage({
        to: "gravity2",
        text: "acceptance test prompt",
        messageId: "msg-acc-1",
        requestId: "req-acc-1",
      });

      if (!receipt.accepted || receipt.status !== "queued_local") {
        console.error("Send receipt not accepted");
        process.exit(2);
      }

      await client.close();
      console.log("CLIENT1_SUCCESS");
    `;

    const clientProc1 = spawn("node", ["--input-type=module", "-e", clientScript1], {
      stdio: ["ignore", "pipe", "inherit"],
    });

    await new Promise((resolve, reject) => {
      let out = "";
      clientProc1.stdout.on("data", (chunk) => { out += chunk; });
      clientProc1.on("close", (code) => {
        if (code === 0 && out.includes("CLIENT1_SUCCESS")) resolve();
        else reject(new Error("Client 1 failed with code " + code + ": " + out));
      });
    });

    // Client process 2: separate process reconnects, waits for reply, checks text, consumes reply
    const clientScript2 = `
      import { createLocalControlClient } from "${new URL("../src/local-messaging-client.mjs", import.meta.url).href}";

      const client = createLocalControlClient({
        socketPath: "${socketPath}",
        turnCredential: "${codexToken}",
        senderId: "desktop-codex",
      });

      const reply = await client.waitForReply({
        requestId: "req-acc-1",
        timeoutMs: 3000,
        pollIntervalMs: 50,
      });

      if (!reply || reply.text !== "ECHO:acceptance test prompt") {
        console.error("Invalid reply: " + JSON.stringify(reply));
        process.exit(1);
      }

      const consumeRes = await client.consumeReply({ messageId: reply.messageId });
      if (!consumeRes.consumed) {
        console.error("Failed to consume reply");
        process.exit(2);
      }

      const remaining = await client.listReplies({ requestId: "req-acc-1" });
      if (remaining.length !== 0) {
        console.error("Remaining replies not empty");
        process.exit(3);
      }

      await client.close();
      console.log("CLIENT2_SUCCESS");
    `;

    const clientProc2 = spawn("node", ["--input-type=module", "-e", clientScript2], {
      stdio: ["ignore", "pipe", "inherit"],
    });

    await new Promise((resolve, reject) => {
      let out = "";
      clientProc2.stdout.on("data", (chunk) => { out += chunk; });
      clientProc2.on("close", (code) => {
        if (code === 0 && out.includes("CLIENT2_SUCCESS")) resolve();
        else reject(new Error("Client 2 failed with code " + code + ": " + out));
      });
    });

  } finally {
    serverProc.kill("SIGTERM");
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
