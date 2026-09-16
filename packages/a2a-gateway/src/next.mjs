import { createOutboundA2AHandler } from "./outbound-a2a.mjs";

/**
 * Bind an agent gateway Web Handler into a Next.js App Router forwarder.
 * Agent apps keep a one-line `_gateway-route.mjs` that injects their local
 * `api/gateway.mjs` default export.
 */
export function createForwardGatewayRequest(gateway) {
  if (!gateway || typeof gateway.fetch !== "function") {
    throw new TypeError("gateway.fetch is required");
  }
  return function forwardGatewayRequest(request) {
    return gateway.fetch(request);
  };
}

/**
 * Build named Next.js App Router method exports that forward to the gateway.
 * Usage in agent `app/.../route.mjs`:
 *   export const { GET } = createGatewayRouteHandlers(forward, ["GET"]);
 */
export function createGatewayRouteHandlers(forwardGatewayRequest, methods) {
  if (typeof forwardGatewayRequest !== "function") {
    throw new TypeError("forwardGatewayRequest must be a function");
  }
  if (!Array.isArray(methods) || methods.length === 0) {
    throw new TypeError("methods must be a non-empty array of HTTP method names");
  }

  const handlers = {};
  for (const method of methods) {
    if (typeof method !== "string" || method.trim().length === 0) {
      throw new TypeError("methods must be non-empty strings");
    }
    handlers[method] = function gatewayRouteHandler(request) {
      return forwardGatewayRequest(request);
    };
  }
  return handlers;
}

/**
 * Lazy singleton Next.js handlers for `/internal/a2a/outbound`.
 * Mirrors the previous per-agent route module behavior.
 */
export function createOutboundA2ARouteHandlers(options = {}) {
  const createHandler =
    typeof options.createHandler === "function"
      ? options.createHandler
      : createOutboundA2AHandler;
  let handler;
  return {
    POST(request) {
      handler ||= createHandler();
      return handler(request);
    },
  };
}

/** Shared Next.js config for A2A gateway agent apps. */
export const gatewayNextConfig = {
  pageExtensions: ["js", "jsx", "ts", "tsx", "mjs"],
};

/**
 * Shared Vercel project config for A2A gateway agent apps.
 * Agent `vercel.json` files must stay byte-compatible with this object
 * (Vercel cannot import package JSON; the next.test.mjs contract enforces it).
 */
export const gatewayVercelConfig = {
  $schema: "https://openapi.vercel.sh/vercel.json",
  framework: "nextjs",
};
