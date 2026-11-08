// Shared scratch fixture for the registry upgrade and restore command tests (D1.3): an application root with a client
// directory, a v1 registry of two bindings, a supervisor runtime manifest, and a fake supervisor status. Nothing here touches
// an installed host.
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { main } from "../src/cli.mjs";
import { bindProfileInRegistry, initIdentityRegistry } from "../../agent-worker/test/local-messaging-identity-fixtures.mjs";

export const REGISTRY_FILE = "identity-registry-v1.json";
export const AUDIT_FILE = "registry-audit.jsonl";
export const V1 = "identity_registry_v1";
export const V2 = "identity_registry_v2";
export const START = Date.now() + 60_000; // after the fixture registry was created, as the writer requires

export function clock(offsetSeconds = 0) {
  return () => new Date(START + offsetSeconds * 1000).toISOString();
}
export const stamp = (iso) => `${iso.slice(0, 19).replace(/[-:]/g, "")}Z`;

// What a supervisor of this release reports about the registry it reads: the schemas it can read, and a digest of the directory.
// ROOT_AUTO is replaced by the fixture with the digest of its own registry directory.
export const ROOT_AUTO = "auto";
export const sha256Hex = (text) => createHash("sha256").update(text, "utf8").digest("hex");
export function okStatus(over = {}) {
  return {
    ok: true,
    router: { enabled: true, registry: { state: "ok", sequence: 3, schema: V1, supportedSchemas: [V1, V2], rootSha256: ROOT_AUTO }, ...over },
  };
}

export function writeManifest(app, version = 14, mode = 0o600) {
  const dir = path.join(app, "worker-runtime");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, "supervisor.manifest.json");
  fs.writeFileSync(file, typeof version === "string" ? version : JSON.stringify({ version }));
  fs.chmodSync(file, mode);
}

export function fixture(t, { manifest = 14, status = okStatus(), registry = true } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "reg-upgrade-cli-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = path.join(root, "The Triangle");
  fs.mkdirSync(app, { mode: 0o700 });
  const client = path.join(app, "client");
  fs.mkdirSync(client, { mode: 0o700 });
  const reg = path.join(app, "identity");
  if (registry) {
    initIdentityRegistry(reg);
    bindProfileInRegistry(reg, "alpha", 1);
    bindProfileInRegistry(reg, "beta", 2);
  }
  if (manifest !== null) writeManifest(app, manifest);
  const files = () => [REGISTRY_FILE, AUDIT_FILE].map((name) => fs.readFileSync(path.join(reg, name)).toString("hex"));
  const state = { status };
  const dependencies = (extra = {}) => ({
    isTerminal: true,
    now: clock(),
    runSupervisorStatus: async () => {
      if (state.status instanceof Error) throw state.status;
      const registry = state.status?.router?.registry;
      if (registry && registry.rootSha256 === ROOT_AUTO) {
        return { ...state.status, router: { ...state.status.router, registry: { ...registry, rootSha256: sha256Hex(reg) } } };
      }
      return state.status;
    },
    ...extra,
  });
  const run = async (sub, args = [], extra = {}) => {
    const out = [];
    const err = [];
    const code = await main(["identity", sub, "--client-root", client, ...args], {
      env: {},
      io: { stdout: (s) => out.push(s), stderr: (s) => err.push(s) },
      identityDependencies: dependencies(extra.identityDependencies),
    });
    return { code, out: out.join("\n"), err: err.join("\n") };
  };
  const backups = () => {
    const dir = path.join(app, "identity-backups");
    return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
  };
  // every path under the application root with its size, to prove a plan wrote nothing
  const listing = () => {
    const rows = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
        const full = path.join(dir, entry.name);
        rows.push(`${path.relative(root, full)}:${entry.isDirectory() ? "dir" : fs.statSync(full).size}`);
        if (entry.isDirectory()) walk(full);
      }
    };
    walk(root);
    return rows;
  };
  return { root, app, client, registry: reg, files, state, run, backups, listing, plan: async (extra) => JSON.parse((await run("upgrade-registry", ["--json"], extra)).out) };
}

