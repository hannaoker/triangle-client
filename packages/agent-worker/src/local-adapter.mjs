import { coded } from "./local-messaging-errors.mjs";
import { MAX_FIELD_STRING_LENGTH } from "./local-messaging-protocol.mjs";
import { localState, validateTransportAdapter } from "./transport-adapter-contract.mjs";

/** R0: wraps an existing authenticated client; owns neither client nor identity. */
export function createLocalAdapter({ client, getCredential } = {}) {
  const methods = ["listSessions", "discoverRecipients", "sendMessage", "listInbox",
    "getMessageStatus", "listReplies", "consumeReply"];
  if (!client || methods.some(method => typeof client[method] !== "function") ||
      typeof getCredential !== "function") {
    throw coded("invalid_transport_adapter", "Local client and credential provider are required");
  }
  function check(options = {}) {
    if (!options || typeof options !== "object" || Array.isArray(options)) {
      throw coded("invalid_arguments", "Local adapter options must be an object");
    }
    if (options.via !== undefined && options.via !== "local") {
      throw coded("route_unavailable", "R0 supports only the local route");
    }
    if (options.deliverBy !== undefined || (options.waitMs !== undefined && options.waitMs !== 0)) {
      throw coded("unsupported", "R0 does not implement delivery deadlines or waiting");
    }
  }
  async function credential() {
    const value = await getCredential();
    if (typeof value !== "string" || !value) throw coded("unauthorized", "A current local credential is required");
    return { credential: value };
  }
  function observe(result) {
    return { ...result, route: "local", state: localState(result.phase ?? result.status),
      evidence: "local_journal" };
  }
  async function discover(options = {}) {
    check(options);
    const auth = await credential();
    const sessions = await client.listSessions(auth);
    const allowed = new Set(await client.discoverRecipients(auth));
    return sessions.map(session => ({ ...session, route: "local", sendEligible: allowed.has(session.id) }));
  }
  return validateTransportAdapter({
    describe() {
      return { route: "local", experimental: true, automaticRetry: false,
        deliveryDeadlines: false, waiting: false, maxTextLength: MAX_FIELD_STRING_LENGTH,
        states: ["received", "executing", "held", "completed", "unknown"],
        retention: "Native journal policy; missing history is not delivery expiry",
        ordering: "Native dispatcher ordering; no additional guarantee" };
    },
    discover,
    async reach(target, options = {}) {
      const session = (await discover(options)).find(row => row.id === target);
      return { route: "local", target, visible: Boolean(session),
        sendEligible: session?.sendEligible === true, presence: session?.presence ?? "unknown" };
    },
    async send(input = {}) {
      check(input);
      // Stable caller-owned IDs are mandatory so even an unknown RPC outcome is retryable.
      for (const key of ["messageId", "requestId"]) {
        if (typeof input[key] !== "string" || !/^[A-Za-z0-9._:-]{1,256}$/.test(input[key])) {
          throw coded("invalid_message", `A stable ${key} is required`);
        }
      }
      const { to, text, messageId, requestId, inReplyTo = null, metadata = {} } = input;
      return observe(await client.sendMessage({ to, text, messageId, requestId, inReplyTo, metadata }, await credential()));
    },
    async status(input = {}) {
      check(input);
      // not_found propagates: no tombstone exists to distinguish pruning from a bad ID.
      return observe(await client.getMessageStatus({ messageId: input.messageId }, await credential()));
    },
    async poll(input = {}) {
      check(input);
      const items = await client.listInbox({ limit: input.limit ?? 50, cursor: input.cursor ?? null }, await credential());
      return { route: "local", items: [...items], nextCursor: items.nextCursor ?? null };
    },
    async replies(input = {}) {
      check(input);
      return { route: "local", items: await client.listReplies({ requestId: input.requestId ?? null,
        inReplyTo: input.inReplyTo ?? null, limit: input.limit ?? 50 }, await credential()) };
    },
    async consume(input = {}) {
      check(input);
      return client.consumeReply({ messageId: input.messageId }, await credential());
    },
  });
}
