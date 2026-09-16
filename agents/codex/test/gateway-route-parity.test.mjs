import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));

const IDENTICAL_PAIRS = [
  "app/_gateway-route.mjs",
  "app/api/v1/route.mjs",
  "app/health/route.mjs",
  "app/internal/a2a/outbound/route.mjs",
  "app/.well-known/agent-card.json/route.mjs",
  "app/.well-known/mesh-proof.json/route.mjs",
  "next.config.mjs",
  "vercel.json",
];

test("Codex and Hermes share identical Next/Vercel route wrappers", () => {
  for (const relative of IDENTICAL_PAIRS) {
    const codex = readFileSync(path.join(root, "agents/codex", relative));
    const hermes = readFileSync(path.join(root, "agents/hermes", relative));
    assert.deepEqual(
      codex,
      hermes,
      `${relative} drifted between agents/codex and agents/hermes`,
    );
  }
});
