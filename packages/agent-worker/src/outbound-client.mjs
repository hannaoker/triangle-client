const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

function required(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${name} is required`);
  }
  return value.trim();
}

function origin(value) {
  const url = new URL(required(value, "gatewayUrl"));
  const local =
    url.protocol === "http:" &&
    ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if ((url.protocol !== "https:" && !local) || url.username || url.password) {
    throw new TypeError("gatewayUrl must use HTTPS");
  }
  return url.toString().replace(/\/$/, "");
}

export function createOutboundClient(
  { gatewayUrl, internalToken },
  { fetchImpl = globalThis.fetch } = {},
) {
  const gatewayOrigin = origin(gatewayUrl);
  const token = required(internalToken, "internalToken");

  async function call(body) {
    const response = await fetchImpl(
      new Request(`${gatewayOrigin}/internal/a2a/outbound`, {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      }),
    );
    const text = await response.text();
    if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) {
      throw new Error("Gateway response is too large");
    }
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error("Gateway returned invalid JSON");
    }
    if (!response.ok) {
      throw new Error(`Gateway request failed with status ${response.status}`);
    }
    if (!payload?.task?.id || !payload.task.contextId || !payload.task.status?.state) {
      throw new Error("Gateway returned an invalid task");
    }
    return payload;
  }

  return {
    send({ recipientAgentId, messageId, contextId, text }) {
      return call({
        operation: "send",
        recipient_agent_id: required(recipientAgentId, "recipientAgentId"),
        message_id: required(messageId, "messageId"),
        ...(contextId ? { context_id: required(contextId, "contextId") } : {}),
        text: required(text, "text"),
      });
    },
    getTask({ recipientAgentId, taskId }) {
      return call({
        operation: "get_task",
        recipient_agent_id: required(recipientAgentId, "recipientAgentId"),
        task_id: required(taskId, "taskId"),
      });
    },
  };
}

