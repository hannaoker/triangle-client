import readline from "node:readline";
import { sanitizeError } from "./local-messaging-errors.mjs";
import { MAX_FRAME_BYTES, MAX_FIELD_STRING_LENGTH } from "./local-messaging-protocol.mjs";

export const MCP_TOOLS = [
  {
    name: "triangle_list_recipients",
    description: "Discover authorized local agent recipients on this host.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "triangle_send_message",
    description: "Send a message to an authorized local recipient agent on this host.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Target agent profile or ID" },
        text: { type: "string", description: "Message body text" },
        messageId: { type: "string", description: "Stable message ID for idempotency" },
        requestId: { type: "string", description: "Correlation request ID" },
        inReplyTo: { type: "string", description: "Message ID being replied to" },
      },
      required: ["to", "text"],
    },
  },
  {
    name: "triangle_get_status",
    description: "Inspect the delivery and processing status of a message.",
    inputSchema: {
      type: "object",
      properties: {
        messageId: { type: "string", description: "Message ID to inspect" },
      },
      required: ["messageId"],
    },
  },
  {
    name: "triangle_get_replies",
    description: "Retrieve pending replies from local agents for this session.",
    inputSchema: {
      type: "object",
      properties: {
        requestId: { type: "string", description: "Filter by correlation request ID" },
        inReplyTo: { type: "string", description: "Filter by inReplyTo message ID" },
      },
    },
  },
  {
    name: "triangle_consume_reply",
    description: "Explicitly mark a retrieved reply as consumed by the caller.",
    inputSchema: {
      type: "object",
      properties: {
        messageId: { type: "string", description: "Message ID of reply to consume" },
      },
      required: ["messageId"],
    },
  },
  {
    name: "triangle_cancel_message",
    description: "Signal cancellation of a sent message (unsupported on local route).",
    inputSchema: {
      type: "object",
      properties: {
        messageId: { type: "string", description: "Message ID to cancel" },
      },
      required: ["messageId"],
    },
  },
];

/**
 * createLocalMessagingMcpHandler:
 *
 * DYNAMIC PER-TURN INJECTION SEAM:
 * A persistent stdio process does not automatically refresh process.env across turns.
 * The MCP adapter accepts either a static credential string or a dynamic callback
 * `turnCredentialProvider: () => string | Promise<string>` to acquire the active turn credential.
 */
export function createLocalMessagingMcpHandler({
  client,
  credentialValidator,
  turnCredential = null,
  turnCredentialProvider = null,
  senderId,
}) {
  async function resolveActiveTurnCredential() {
    if (typeof turnCredentialProvider === "function") {
      const cred = await turnCredentialProvider();
      if (cred) return cred;
    }
    return turnCredential;
  }

  async function verifyTurnCredential() {
    const cred = await resolveActiveTurnCredential();
    if (!cred) {
      throw new Error("unauthorized: missing injected turn credential");
    }
    if (credentialValidator) {
      credentialValidator.validate({ credential: cred, expectedSenderId: senderId });
    }
    return cred;
  }

  return {
    async handleRequest(request) {
      // Validate request shape: invalid scalar or null safely returns JSON-RPC Invalid Request
      if (!request || typeof request !== "object" || Array.isArray(request)) {
        return {
          jsonrpc: "2.0",
          id: null,
          error: {
            code: -32600,
            message: "Invalid Request: request must be a JSON object",
          },
        };
      }

      const { id, method, params = {} } = request;

      // Notifications (requests without an id property) MUST NOT receive a response per JSON-RPC 2.0
      const isNotification = typeof id === "undefined";

      // Explicitly handle notifications/initialized notification
      if (method === "notifications/initialized" || isNotification) {
        return null;
      }

      try {
        switch (method) {
          case "initialize":
            return {
              jsonrpc: "2.0",
              id,
              result: {
                protocolVersion: "2024-11-05",
                capabilities: { tools: {} },
                serverInfo: {
                  name: "triangle-local-messaging-mcp",
                  version: "0.1.0",
                },
              },
            };

          case "tools/list":
            return {
              jsonrpc: "2.0",
              id,
              result: {
                tools: MCP_TOOLS,
              },
            };

          case "tools/call": {
            await verifyTurnCredential();
            const { name, arguments: args = {} } = params;

            if (!args || typeof args !== "object") {
              throw new Error("Invalid tool arguments: expected object");
            }

            // Enforce bounded tool arguments
            if (args.text && (typeof args.text !== "string" || args.text.length > MAX_FIELD_STRING_LENGTH)) {
              throw new Error(`Tool argument 'text' exceeds maximum limit of ${MAX_FIELD_STRING_LENGTH}`);
            }

            let resultData;

            switch (name) {
              case "triangle_list_recipients": {
                const recipients = await client.discoverRecipients();
                resultData = { recipients };
                break;
              }

              case "triangle_send_message": {
                const res = await client.sendMessage({
                  to: args.to,
                  text: args.text,
                  messageId: args.messageId,
                  requestId: args.requestId,
                  inReplyTo: args.inReplyTo,
                });
                resultData = res;
                break;
              }

              case "triangle_get_status": {
                const res = await client.getMessageStatus({ messageId: args.messageId });
                resultData = res;
                break;
              }

              case "triangle_get_replies": {
                const replies = await client.listReplies({
                  requestId: args.requestId,
                  inReplyTo: args.inReplyTo,
                });
                resultData = { replies };
                break;
              }

              case "triangle_consume_reply": {
                const res = await client.consumeReply({ messageId: args.messageId });
                resultData = res;
                break;
              }

              case "triangle_cancel_message": {
                const res = await client.cancelMessage({ messageId: args.messageId });
                resultData = res;
                break;
              }

              default:
                throw new Error(`Unknown tool: ${name}`);
            }

            return {
              jsonrpc: "2.0",
              id,
              result: {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify(resultData),
                  },
                ],
                isError: false,
              },
            };
          }

          default:
            return {
              jsonrpc: "2.0",
              id,
              error: {
                code: -32601,
                message: `Method not found: ${method}`,
              },
            };
        }
      } catch (err) {
        const { code, message } = sanitizeError(err);
        if (method === "tools/call") {
          return {
            jsonrpc: "2.0",
            id,
            result: {
              content: [
                {
                  type: "text",
                  text: `Error (${code}): ${message}`,
                },
              ],
              isError: true,
            },
          };
        }
        return {
          jsonrpc: "2.0",
          id,
          error: {
            code: -32000,
            message: `${code}: ${message}`,
          },
        };
      }
    },
  };
}

export async function runMcpStdioSession({
  input = process.stdin,
  output = process.stdout,
  handler,
}) {
  const rl = readline.createInterface({
    input,
    crlfDelay: Infinity,
    terminal: false,
  });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Bounded line parsing: reject oversized lines
    if (Buffer.byteLength(trimmed, "utf8") > MAX_FRAME_BYTES) {
      output.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Parse error: line exceeds maximum allowed frame size" },
        }) + "\n",
      );
      continue;
    }

    let req;
    try {
      req = JSON.parse(trimmed);
    } catch {
      output.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Parse error" },
        }) + "\n",
      );
      continue;
    }

    const resp = await handler.handleRequest(req);
    // Notifications MUST NOT emit any response per JSON-RPC 2.0
    if (resp !== null && typeof resp !== "undefined") {
      output.write(JSON.stringify(resp) + "\n");
    }
  }
}
