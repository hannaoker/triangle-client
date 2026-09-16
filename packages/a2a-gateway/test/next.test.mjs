import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  createForwardGatewayRequest,
  createGatewayRouteHandlers,
  createOutboundA2ARouteHandlers,
  gatewayNextConfig,
  gatewayVercelConfig,
} from "../src/next.mjs";

const root = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const SHARED_EXPORT = "@the-triangle/a2a-gateway/next";

const AGENT_NEXT_ENTRYPOINTS = [
  "app/_gateway-route.mjs",
  "app/api/v1/route.mjs",
  "app/health/route.mjs",
  "app/internal/a2a/outbound/route.mjs",
  "app/.well-known/agent-card.json/route.mjs",
  "app/.well-known/mesh-proof.json/route.mjs",
  "next.config.mjs",
];

test("createForwardGatewayRequest forwards to gateway.fetch", async () => {
  const seen = [];
  const forward = createForwardGatewayRequest({
    fetch(request) {
      seen.push(request.url);
      return new Response("ok");
    },
  });
  const response = await forward(new Request("https://agent.example/health"));
  assert.equal(await response.text(), "ok");
  assert.deepEqual(seen, ["https://agent.example/health"]);
});

test("createForwardGatewayRequest rejects invalid gateways", () => {
  assert.throws(() => createForwardGatewayRequest(null), /gateway\.fetch is required/);
  assert.throws(() => createForwardGatewayRequest({}), /gateway\.fetch is required/);
});

test("createGatewayRouteHandlers exports named HTTP methods", async () => {
  const calls = [];
  const forward = (request) => {
    calls.push(request.method);
    return new Response("forwarded");
  };
  const { GET, POST } = createGatewayRouteHandlers(forward, ["GET", "POST"]);
  assert.equal(await (await GET(new Request("https://agent.example/health"))).text(), "forwarded");
  assert.equal(
    await (await POST(new Request("https://agent.example/api/v1", { method: "POST" }))).text(),
    "forwarded",
  );
  assert.deepEqual(calls, ["GET", "POST"]);
});

test("createGatewayRouteHandlers validates inputs", () => {
  assert.throws(() => createGatewayRouteHandlers(null, ["GET"]), /forwardGatewayRequest/);
  assert.throws(() => createGatewayRouteHandlers(() => {}, []), /methods/);
  assert.throws(() => createGatewayRouteHandlers(() => {}, [""]), /methods/);
});

test("createOutboundA2ARouteHandlers lazy-initializes once", async () => {
  let builds = 0;
  const { POST } = createOutboundA2ARouteHandlers({
    createHandler() {
      builds += 1;
      return async () => new Response("outbound", { status: 201 });
    },
  });
  assert.equal((await POST(new Request("https://agent.example/internal/a2a/outbound", { method: "POST" }))).status, 201);
  assert.equal((await POST(new Request("https://agent.example/internal/a2a/outbound", { method: "POST" }))).status, 201);
  assert.equal(builds, 1);
});

test("shared Next and Vercel configs stay stable", () => {
  assert.deepEqual(gatewayNextConfig, {
    pageExtensions: ["js", "jsx", "ts", "tsx", "mjs"],
  });
  assert.deepEqual(gatewayVercelConfig, {
    $schema: "https://openapi.vercel.sh/vercel.json",
    framework: "nextjs",
  });
});

test("Codex and Hermes Next entrypoints consume shared a2a-gateway/next helpers", () => {
  for (const agent of ["codex", "hermes"]) {
    for (const relative of AGENT_NEXT_ENTRYPOINTS) {
      const source = readFileSync(path.join(root, "agents", agent, relative), "utf8");
      assert.match(
        source,
        new RegExp(SHARED_EXPORT.replaceAll("/", "\\/")),
        `${agent}/${relative} must import ${SHARED_EXPORT}`,
      );
      assert.doesNotMatch(
        source,
        /gateway\.fetch\s*\(/,
        `${agent}/${relative} must not inline gateway.fetch forwarding`,
      );
    }

    const vercel = JSON.parse(
      readFileSync(path.join(root, "agents", agent, "vercel.json"), "utf8"),
    );
    assert.deepEqual(
      vercel,
      gatewayVercelConfig,
      `${agent}/vercel.json must match gatewayVercelConfig`,
    );
  }
});
