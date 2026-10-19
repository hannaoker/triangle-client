// Workload-only trusted network boundary. Never construct an owner session.
import { AsyncLocalStorage } from "node:async_hooks";
import { openCustody } from "../../triangle-cli/src/custody.mjs";
import {
  createTransport as createHttp,
  loadTransportHeaders,
} from "../../triangle-cli/src/transport.mjs";
import {
  createWorkloadSession,
  awaitWithSignal,
} from "../../triangle-cli/src/workload.mjs";
import { replyDigest } from "./transaction.mjs";
const id = (v, p) =>
  typeof v === "string" && new RegExp("^" + p + "_[a-f0-9]{32}$").test(v);
const positive = (n) => Number.isSafeInteger(n) && n > 0;
function eventKey(event) {
  if (
    event.idempotency_key !== undefined &&
    event.idempotencyKey !== undefined &&
    event.idempotency_key !== event.idempotencyKey
  )
    fail();
  return event.idempotency_key ?? event.idempotencyKey;
}
function bound(r) {
  if (
    !r ||
    !positive(r.deliveryId) ||
    !id(r.roomId, "room") ||
    !id(r.eventId, "event") ||
    !positive(r.roomSequence) ||
    !id(r.claimId, "claim") ||
    !id(r.replyKey, "reply")
  )
    throw Error("invalid_transaction_binding");
}

function fail() {
  throw Object.assign(Error("invalid_authority_response"), {
    code: "invalid_authority_response",
  });
}
const bounded = (t) =>
  typeof t === "string" && t.trim() && Buffer.byteLength(t) <= 32768;
export function createTransport({
  identityHome,
  agentId,
  env = process.env,
  fetchImpl = globalThis.fetch,
}) {
  if (!id(agentId, "agent")) throw Error("invalid_agent");
  const custody = openCustody(identityHome);
  const authority = custody.readAuthority(),
    agent = custody.readAgent(agentId),
    key = custody.readWorkloadKey(agentId);
  if (
    !authority ||
    !agent ||
    agent.agent_id !== agentId ||
    !agent.workload_id ||
    !key
  )
    throw Error("workload_identity_unavailable");
  const context = new AsyncLocalStorage();
  const http = createHttp({
    ...authority,
    headers: loadTransportHeaders(env.TRIANGLE_TRANSPORT_HEADERS_FILE),
    allowLoopbackHttp: env.TRIANGLE_ALLOW_LOOPBACK_HTTP === "1",
    fetchImpl: (url, options) => {
      const s = context.getStore();
      s?.throwIfAborted();
      return fetchImpl(url, {
        ...options,
        signal: s ? AbortSignal.any([s, options.signal]) : options.signal,
      });
    },
  });
  const session = createWorkloadSession({
    transport: http,
    workloadId: agent.workload_id,
    workloadKey: key,
  });
  const request = (method, url, body, signal) =>
    context.run(signal, async () => {
      signal?.throwIfAborted();
      const response = await awaitWithSignal(
        session.request(method, url, { body }),
        signal,
      );
      signal?.throwIfAborted();
      return response.body;
    });
  const history = async (r, after, limit, signal) => {
    const page = await request(
      "GET",
      `/api/v1/rooms/${r.roomId}/events?after_sequence=${after}&limit=${limit}`,
      undefined,
      signal,
    );
    if (
      page?.roomId !== r.roomId ||
      !Array.isArray(page.items) ||
      page.items.length > limit
    )
      fail();
    return page.items;
  };
  function matchReply(r, e) {
    if (
      !e ||
      !id(e.id, "event") ||
      e.roomId !== r.roomId ||
      !positive(e.sequence) ||
      e.sequence <= r.roomSequence ||
      e.type !== "message.created" ||
      e.senderAgentId !== agentId ||
      eventKey(e) !== r.replyKey ||
      e.body?.replyRequired !== false ||
      e.body.inReplyToEventId !== r.eventId ||
      !bounded(e.body.text) ||
      !r.replyDigest ||
      replyDigest(e.body.text) !== r.replyDigest
    )
      fail();
    return { eventId: e.id, sequence: e.sequence };
  }
  const api = {
    async verify({ signal } = {}) {
      await context.run(signal, () =>
        awaitWithSignal(http.verifyAuthority(), signal),
      );
      const b = await request("GET", "/api/v1/agents/me", undefined, signal);
      if (b?.agent?.id !== agentId) fail();
      if ((b.agent.state ?? b.state) && (b.agent.state ?? b.state) !== "active")
        throw Object.assign(Error("agent_not_active"), {
          code: "agent_not_active",
        });
      if (
        b.permissions?.enabled === false ||
        b.permissions?.["dm.send"] === false ||
        b.permissions?.["dm.receive"] === false
      )
        throw Object.assign(Error("agent_paused"), { code: "agent_paused" });
      return {
        agentId,
        handle: b.agent.handle ?? null,
        permissions: b.permissions ?? null,
      };
    },
    async list({ signal } = {}) {
      const b = await request(
        "GET",
        "/api/v1/mailbox?after=0&limit=1",
        undefined,
        signal,
      );
      if (!Array.isArray(b?.items) || b.items.length > 1) fail();
      return b.items.map((d) => {
        if (
          !positive(d.deliveryId) ||
          !id(d.roomId, "room") ||
          !id(d.eventId, "event") ||
          !positive(d.roomSequence) ||
          d.state !== "pending"
        )
          fail();
        return {
          deliveryId: d.deliveryId,
          roomId: d.roomId,
          eventId: d.eventId,
          roomSequence: d.roomSequence,
        };
      });
    },
    async claim(r, { signal } = {}) {
      bound(r);
      const b = await request(
        "POST",
        "/api/v1/mailbox/claim",
        { delivery_id: r.deliveryId, claim_id: r.claimId },
        signal,
      );
      if (
        b?.claimed !== true ||
        b.claimId !== r.claimId ||
        typeof b.idempotent !== "boolean" ||
        !Number.isFinite(Date.parse(b.claimedAt)) ||
        !Number.isFinite(Date.parse(b.leaseExpiresAt))
      )
        fail();
      return { leaseExpiresAt: b.leaseExpiresAt };
    },
    async inbound(r, { signal } = {}) {
      bound(r);
      const [e] = await history(r, r.roomSequence - 1, 1, signal);
      if (
        !e ||
        e.id !== r.eventId ||
        e.roomId !== r.roomId ||
        e.sequence !== r.roomSequence ||
        e.type !== "message.created" ||
        !id(e.senderAgentId, "agent") ||
        e.senderAgentId === agentId ||
        !bounded(e.body?.text) ||
        (e.body.replyRequired !== undefined &&
          typeof e.body.replyRequired !== "boolean")
      )
        fail();
      return {
        messageId: r.eventId,
        taskId: r.eventId,
        contextId: r.roomId,
        senderId: e.senderAgentId,
        recipientId: agentId,
        text: e.body.text,
        replyRequired: e.body.replyRequired !== false,
      };
    },
    async findReply(r, { signal } = {}) {
      bound(r);
      let after = r.roomSequence;
      for (let i = 0; i < 100; i++) {
        const items = await history(r, after, 100, signal);
        let last = after;
        for (const e of items) {
          if (!positive(e?.sequence) || e.sequence <= last) fail();
          last = e.sequence;
          if (eventKey(e) === r.replyKey) return matchReply(r, e);
        }
        if (items.length < 100) return null;
        after = last;
      }
      fail();
    },
    async reply(r, text, { signal } = {}) {
      bound(r);
      if (!bounded(text) || replyDigest(text) !== r.replyDigest) fail();
      const b = await request(
        "POST",
        `/api/v1/rooms/${r.roomId}/events`,
        {
          type: "message.created",
          body: { text, replyRequired: false, inReplyToEventId: r.eventId },
          idempotency_key: r.replyKey,
        },
        signal,
      );
      return matchReply(r, b?.event);
    },
    async ack(r, { signal } = {}) {
      bound(r);
      if (
        r.phase !== "replied" ||
        (!r.receiptOnly && (!id(r.replyEventId, "event") || !r.replyDigest))
      )
        throw Error("unverified_ack");
      const b = await request(
        "POST",
        "/api/v1/mailbox/ack",
        {
          delivery_ids: [r.deliveryId],
          status: "processed",
          claims: [{ delivery_id: r.deliveryId, claim_id: r.claimId }],
        },
        signal,
      );
      if (
        !Number.isSafeInteger(b?.acknowledged) ||
        b.acknowledged < 0 ||
        b.acknowledged > 1
      )
        fail();
      return { acknowledged: b.acknowledged };
    },
  };
  return Object.freeze(api);
}
