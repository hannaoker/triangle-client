import { createRequire } from "node:module";

import { createMeshMailboxBridge } from "./mesh-mailbox-bridge.mjs";
import { createVercelGatewayHandler } from "./vercel-handler.mjs";

const require = createRequire(import.meta.url);
const { createMeshPeerIntrospector } = require("./protocol.cjs");

const REQUIRED_ENV = [
  "MESH_ORIGIN",
  "MESH_AGENT_TOKEN",
  "MESH_REGISTRATION_NONCE",
];
const MESH_AGENT_ID_PATTERN = /^agent_[a-f0-9]{32}$/;

function required(env, name) {
  const value = env[name];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} is required`);
  }
  return value.trim();
}

function httpsOrigin(value, name) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }
  const localHttp =
    parsed.protocol === "http:" &&
    ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);
  if (
    (parsed.protocol !== "https:" && !localHttp) ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(`${name} must be an HTTPS origin`);
  }
  return parsed.origin;
}

function agentOrigin(env) {
  if (typeof env.AGENT_ORIGIN === "string" && env.AGENT_ORIGIN.trim()) {
    return httpsOrigin(env.AGENT_ORIGIN.trim(), "AGENT_ORIGIN");
  }
  const productionHost = env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  if (!productionHost) {
    throw new Error(
      "AGENT_ORIGIN or VERCEL_PROJECT_PRODUCTION_URL is required",
    );
  }
  if (
    !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::\d+)?$/i.test(productionHost)
  ) {
    throw new Error("VERCEL_PROJECT_PRODUCTION_URL must be a valid hostname");
  }
  return httpsOrigin(
    `https://${productionHost}`,
    "VERCEL_PROJECT_PRODUCTION_URL",
  );
}

function recipientIdentity(env, gatewayKey) {
  const name = `${gatewayKey.toUpperCase().replaceAll("-", "_")}_AGENT_ID`;
  const value = required(env, name);
  if (!MESH_AGENT_ID_PATTERN.test(value)) {
    throw new Error(`${name} must be a canonical MESH agent ID`);
  }
  return value;
}

export function createConfiguredGatewayApp({
  gatewayKey,
  profile,
  env = process.env,
  createBridgeImpl = createMeshMailboxBridge,
  createIntrospectorImpl = createMeshPeerIntrospector,
  fetchImpl = globalThis.fetch,
}) {
  if (typeof gatewayKey !== "string" || gatewayKey.length === 0) {
    throw new TypeError("gatewayKey is required");
  }
  for (const name of REQUIRED_ENV) required(env, name);

  const origin = agentOrigin(env);
  const meshOrigin = httpsOrigin(required(env, "MESH_ORIGIN"), "MESH_ORIGIN");
  const recipientAgentId = recipientIdentity(env, gatewayKey);
  const introspectPeerToken = createIntrospectorImpl({
    meshOrigin,
    agentToken: required(env, "MESH_AGENT_TOKEN"),
    fetchImpl,
  });
  let bridgePromise;
  const bridgeFactory = () => {
    bridgePromise ||= Promise.resolve()
      .then(() => createBridgeImpl({
        meshOrigin,
        recipientAgentId,
        meshAgentToken: required(env, "MESH_AGENT_TOKEN"),
        fetchImpl,
      }))
      .catch((error) => {
        bridgePromise = undefined;
        throw error;
      });
    return bridgePromise;
  };
  const handle = createVercelGatewayHandler({
    origin,
    meshOrigin,
    profile,
    recipientAgentId,
    proofNonce: required(env, "MESH_REGISTRATION_NONCE"),
    bridgeFactory,
    introspectPeerToken,
  });

  return { fetch: handle };
}

export function createLazyDefaultApp(createApp) {
  let app;
  return {
    fetch(request) {
      app ||= createApp();
      return app.fetch(request);
    },
  };
}
