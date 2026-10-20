import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  createPeerProofBroker,
  parseEnvelope,
  PROTOCOL,
} from "./peer-proof-broker.mjs";

function loadProof(file, requesterId, responderId) {
  const stat = lstatSync(file, { throwIfNoEntry: false });
  if (!stat) return null;
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.uid !== process.getuid() ||
    (stat.mode & 0o077) !== 0
  )
    throw Error("unsafe_proof_journal");
  let state;
  try {
    state = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw Error("invalid_proof_journal");
  }
  if (
    !state ||
    state.version !== 1 ||
    state.requesterEndpointId !== requesterId ||
    state.responderEndpointId !== responderId ||
    !["started", "completed"].includes(state.phase) ||
    typeof state.requestId !== "string" ||
    typeof state.messageId !== "string" ||
    (state.phase === "completed" &&
      (typeof state.replyMessageId !== "string" ||
        typeof state.replyText !== "string"))
  )
    throw Error("invalid_proof_journal");
  return state;
}

function saveProof(file, state) {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, `${JSON.stringify(state)}\n`);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, file);
    const dir = openSync(path.dirname(file), "r");
    try {
      fsyncSync(dir);
    } finally {
      closeSync(dir);
    }
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    try {
      unlinkSync(temporary);
    } catch {}
    throw error;
  }
}

/** Test control can use SSH-backed IPC adapters; all request/reply delivery is iroh. */
export async function runPeerHarnessProof({
  requester,
  responder,
  requesterAddr,
  responderAddr,
  runner,
  brokerStateRoot,
  timeoutMs = 240000,
  onProgress = () => {},
}) {
  if (requesterAddr.id === responderAddr.id)
    throw Error("Proof requires distinct endpoint identities");
  let calls = 0;
  const responderBroker = createPeerProofBroker({
    stateRoot: brokerStateRoot,
    ipc: responder,
    routes: new Map([[requesterAddr.id, requesterAddr]]),
    runner: {
      async run(request, options) {
        calls++;
        return await runner.run(request, options);
      },
    },
  });
  let requesterBroker;
  try {
    const resultRoot = path.join(brokerStateRoot, "requester-replies");
    const requestBroker = createPeerProofBroker({
      stateRoot: resultRoot,
      ipc: requester,
      routes: new Map([[responderAddr.id, responderAddr]]),
      runner: { async run() { return { status: "failed" }; } },
    });
    requesterBroker = requestBroker;

    const proofFile = path.join(brokerStateRoot, "proof-result.json");
    let state = loadProof(proofFile, requesterAddr.id, responderAddr.id);
    if (!state) {
      state = {
        version: 1,
        requesterEndpointId: requesterAddr.id,
        responderEndpointId: responderAddr.id,
        phase: "started",
        requestId: `harness-${randomUUID()}`,
        messageId: `request-${randomUUID()}`,
      };
      saveProof(proofFile, state);
    }

    const takeReply = (view) => {
      if (
        view?.state !== "reply_received" ||
        view.fromEndpointId !== responderAddr.id ||
        view.envelope.kind !== "reply" ||
        view.envelope.request_id !== state.requestId ||
        view.envelope.in_reply_to !== state.messageId
      )
        return null;
      return view;
    };

    if (state.phase === "started") {
      const payload = JSON.stringify({
        protocol: PROTOCOL,
        kind: "request",
        request_id: state.requestId,
        text: "Compute 17 times 19 plus 23. Explain the arithmetic in one sentence, then write PEER_REAL_CODEX_RESULT followed by the resulting integer. Do not use tools or modify files.",
      });
      const receipt = await requester.request("send", {
        message_id: state.messageId,
        payload,
        peer_addr: responderAddr,
      });
      if (
        receipt.message_id !== state.messageId ||
        receipt.status !== "received_peer"
      )
        throw Error("Unverified input receipt");
      onProgress({ stage: "input_received", messageId: state.messageId });
    }

    if (state.phase === "started") {
      const until = Date.now() + timeoutMs;
      let reply;
      while (Date.now() < until) {
        const result = await responderBroker.step();
        if (result.state !== "idle")
          onProgress({ stage: "responder_step", state: result.state });
        const received = await requesterBroker.step();
        reply = takeReply(received);
        if (!reply) reply = takeReply(requesterBroker.pendingReplies()[0]);
        if (reply) break;
        await delay(250);
      }
      if (!reply) throw Error("No linked harness reply");
      if (!/PEER_REAL_CODEX_RESULT\s+346\b/.test(reply.envelope.text))
        throw Error("Real harness did not complete arithmetic proof");

      // Persist the verified application result before explicitly consuming the
      // durable incoming reply. A restart can replay that reply from requesterReplies.
      state = {
        ...state,
        phase: "completed",
        replyMessageId: reply.messageId,
        replyText: reply.envelope.text,
      };
      saveProof(proofFile, state);
    }

    const pending = requesterBroker.pendingReplies().find((view) => {
      try {
        return takeReply(view)?.messageId === state.replyMessageId;
      } catch {
        return false;
      }
    });
    if (pending)
      requesterBroker.consumeReply({
        fromEndpointId: responderAddr.id,
        messageId: state.replyMessageId,
      });

    // A settled message ID returns its sender-side cached receipt. This checks
    // send idempotency; broker receive-side redelivery is covered separately.
    if (calls > 0) {
      await requester.request("send", {
        message_id: state.messageId,
        payload: JSON.stringify({
          protocol: PROTOCOL,
          kind: "request",
          request_id: state.requestId,
          text: "Compute 17 times 19 plus 23. Explain the arithmetic in one sentence, then write PEER_REAL_CODEX_RESULT followed by the resulting integer. Do not use tools or modify files.",
        }),
        peer_addr: responderAddr,
      });
      await responderBroker.step();
      if (calls !== 1) throw Error("Duplicate inference execution");
    }
    return {
      requestId: state.requestId,
      messageId: state.messageId,
      replyMessageId: state.replyMessageId,
      replyText: state.replyText,
      modelCalls: calls,
      duplicateCheck: "sender-side cached receipt; receive redelivery tested separately",
      senderEndpointId: requesterAddr.id,
      receiverEndpointId: responderAddr.id,
      requesterTransport: await requester.request("transport_diagnostics"),
      responderTransport: await responder.request("transport_diagnostics"),
    };
  } finally {
    requesterBroker?.close();
    responderBroker.close();
  }
}
