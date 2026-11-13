#!/usr/bin/env node
// AD.3 rehearsal helper, derived from the D1.4 host.mjs. The driver (rehearsal-aliases.mjs) always starts this file with a
// runtime bundle's OWN node, and it imports modules only from that bundle, so what runs is the bundle's code and nothing
// from a checkout.
//
//   alias-host.mjs prepare <bundle> <specFile>                               build a scratch client, router and v1 registry from
//                                                                            a JSON spec (a registry already in place is read, not changed)
//   alias-host.mjs run     <bundle> <configPath>                             the production host with echo runners
//   alias-host.mjs read    <bundle> <registryRoot>                           read the registry with the bundle's reader
//   alias-host.mjs ids     <bundle> <profile>...                             the instance id derived for each profile name
//   alias-host.mjs bind    <bundle> <registryRoot> <profile> <expectedSeq>   try a bind with the bundle's writer (v2 binding on a v2 registry)
//   alias-host.mjs force-upgrade <bundle> <registryRoot>                     the audited v1 -> v2 write WITHOUT the floor
//
// The spec of `prepare`: { clientRoot, stateRoot, registryRoot, local: [profile...], bound: [profile...], init?: boolean }.
// `local` are the client's recipients (workers); `bound` are the profiles that get a mesh-managed binding in a registry made
// here. A profile can be local and unbound (the scratch-b of D1.5) or bound and not local (ghost, as in the live registry).
// With `init: false` the registry starts with its first bind, with no `init` entry, as the live registry does (the plan
// allows a first entry that is `init` or `bind`).
//
// Every mode prints one JSON line on stdout. Nothing here touches the live application root: all paths are arguments.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [mode, bundleArg, ...args] = process.argv.slice(2);
if (!mode || !bundleArg) {
  process.stderr.write("usage: alias-host.mjs <prepare|run|read|ids|bind|force-upgrade> <bundleRoot> ...\n");
  process.exit(64);
}
const bundleRoot = fs.realpathSync(bundleArg);
const srcDir = path.join(bundleRoot, "packages/agent-worker/src");
const out = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const hex = (text, length = 64) => crypto.createHash("sha256").update(text).digest("hex").slice(0, length);

async function load(name) {
  const file = path.join(srcDir, name);
  if (!file.startsWith(srcDir + path.sep)) throw new Error("module outside the bundle");
  return import(pathToFileURL(file).href);
}

function makeBinding(registry, primitives, profile) {
  const instanceId = primitives.deriveClientInstanceId(profile);
  return {
    schema: registry.LOCAL_PROFILE_BINDING_SCHEMA,
    binding_id: `bind_${hex(`bind:${profile}`, 32)}`,
    trust_mode: "mesh-managed",
    principal_id: `agent_${hex(`agent:${profile}`, 32)}`,
    profile_name: profile,
    profile_instance_id: instanceId,
    authority_origin: "https://thetriangle.dev",
    binding_generation: 1,
    issued_at: "2026-11-12T10:00:00.000Z",
    revoked_at: null,
    proof: { kind: "disk_observation", observed_on_disk: true, verified_live_authority: false },
  };
}

async function prepare([specFile]) {
  const spec = JSON.parse(fs.readFileSync(specFile, "utf8"));
  const { clientRoot, stateRoot, registryRoot } = spec;
  const local = spec.local ?? [];
  const bound = spec.bound ?? [];
  if (![clientRoot, stateRoot, registryRoot].every((p) => typeof p === "string" && path.isAbsolute(p)) || local.length === 0) {
    throw new Error("prepare needs absolute clientRoot, stateRoot, registryRoot and at least one local profile");
  }
  const cli = await load("local-messaging-cli.mjs");
  const broker = await load("local-messaging-auth-broker.mjs");
  const registry = await load("identity-registry.mjs");
  const primitives = await load("identity-primitives.mjs");

  const senderId = hex("ad3 rehearsal desktop sender");
  const configPath = path.join(clientRoot, "local-messaging.json");
  const bindingPath = path.join(clientRoot, "desktop-binding.json");
  if (!fs.existsSync(bindingPath)) broker.writePrivateJson(bindingPath, { instanceId: senderId, threadId: "rehearsal-thread-0001", enabled: false });
  cli.setupLocalMessaging({
    config: configPath,
    "desktop-binding": bindingPath,
    "thread-id": "rehearsal-thread-0001",
    "state-root": stateRoot,
    recipients: local,
  });
  cli.setupRouter({ enable: true, registryRoot, stateRoot });

  const config = broker.readPrivateJson(configPath);
  for (const profile of local) {
    const recipient = config.recipients.find((r) => r.profile === profile);
    if (recipient?.instanceId !== primitives.deriveClientInstanceId(profile)) {
      throw new Error(`recipient instance id for ${profile} does not match deriveClientInstanceId`);
    }
  }

  fs.mkdirSync(registryRoot, { recursive: true, mode: 0o700 });
  fs.chmodSync(registryRoot, 0o700);
  const principals = {};
  const instances = {};
  let sequence;
  const existing = registry.readIdentityRegistry({ root: registryRoot });
  if (existing.state === "ok") {
    // A registry is already in place (a second call, to add a recipient): read it and change nothing.
    sequence = existing.registry.sequence;
    for (const profile of new Set([...local, ...bound])) {
      const binding = Object.values(existing.registry.bindings).find((b) => b.profile_name === profile);
      principals[profile] = binding?.principal_id ?? null;
      instances[profile] = primitives.deriveClientInstanceId(profile);
    }
  } else {
    sequence = 0;
    if (spec.init !== false) {
      registry.updateIdentityRegistry({ root: registryRoot, expectedSequence: 0, action: "init", subject: null, mutate: (r) => r });
      sequence = 1;
    }
    for (const profile of bound) {
      const binding = makeBinding(registry, primitives, profile);
      registry.updateIdentityRegistry({
        root: registryRoot,
        expectedSequence: sequence,
        action: "bind",
        subject: binding.profile_instance_id,
        mutate: (r) => {
          r.bindings[binding.profile_instance_id] = binding;
          return r;
        },
      });
      sequence += 1;
      principals[profile] = binding.principal_id;
    }
    for (const profile of new Set([...local, ...bound])) {
      principals[profile] ??= null;
      instances[profile] = primitives.deriveClientInstanceId(profile);
    }
  }
  out({ ok: true, configPath, senderId, sequence, principals, instances, registryWasInPlace: existing.state === "ok" });
}

async function runHost([configPath]) {
  const hostModule = await load("local-messaging-host.mjs");
  const { createProfiledReasonerGate } = await load("concurrency-gate.mjs");
  const config = hostModule.loadLocalMessagingConfig(configPath);
  const runners = new Map(
    config.recipients.map((r) => [
      r.instanceId,
      { run: async (request) => ({ status: "completed", text: `echo[${r.profile}]: ${request.text}` }) },
    ]),
  );
  const host = hostModule.createInstalledLocalMessagingHost({ configPath, runners, gate: createProfiledReasonerGate() });
  await host.start();
  out({ ready: true, pid: process.pid, bundleRoot, node: process.version });
  const stop = async () => {
    try {
      await host.stop();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  setInterval(() => {}, 1 << 30);
}

async function read([registryRoot]) {
  const registry = await load("identity-registry.mjs");
  try {
    const result = registry.readIdentityRegistry({ root: registryRoot });
    const aliases = result.registry?.aliases ?? {};
    out({
      ok: true,
      state: result.state,
      schema: result.registry?.schema ?? null,
      sequence: result.registry?.sequence ?? null,
      bindings: result.registry ? Object.keys(result.registry.bindings).length : 0,
      aliases: Object.fromEntries(Object.entries(aliases).map(([name, record]) => [name, { principal_id: record.principal_id, generation: record.generation }])),
    });
  } catch (error) {
    out({ ok: false, code: error.code ?? null, message: String(error.message).slice(0, 240) });
  }
}

async function ids(profiles) {
  const primitives = await load("identity-primitives.mjs");
  out(Object.fromEntries(profiles.map((profile) => [profile, primitives.deriveClientInstanceId(profile)])));
}

async function bind([registryRoot, profile, expectedSequence]) {
  const registry = await load("identity-registry.mjs");
  const primitives = await load("identity-primitives.mjs");
  const binding = makeBinding(registry, primitives, profile);
  try {
    // A v2 registry takes the v2 binding (the schema name and a null principal public key).
    if (registry.readIdentityRegistry({ root: registryRoot }).registry?.schema === "identity_registry_v2") {
      binding.schema = registry.LOCAL_PROFILE_BINDING_SCHEMA_V2;
      binding.principal_public_key = null;
    }
    registry.updateIdentityRegistry({
      root: registryRoot,
      expectedSequence: Number(expectedSequence),
      action: "bind",
      subject: binding.profile_instance_id,
      mutate: (r) => {
        r.bindings[binding.profile_instance_id] = binding;
        return r;
      },
    });
    out({ ok: true });
  } catch (error) {
    out({ ok: false, code: error.code ?? null, message: String(error.message).slice(0, 240) });
  }
}

async function forceUpgrade([registryRoot]) {
  const registry = await load("identity-registry.mjs");
  const current = registry.readIdentityRegistry({ root: registryRoot });
  registry.updateIdentityRegistry({
    root: registryRoot,
    expectedSequence: current.registry.sequence,
    action: "upgrade",
    subject: null,
    mutate: (r) => registry.upgradeRegistryV1ToV2(r),
  });
  const after = registry.readIdentityRegistry({ root: registryRoot });
  out({ ok: true, schema: after.registry.schema, sequence: after.registry.sequence });
}

const modes = { prepare, run: runHost, read, ids, bind, "force-upgrade": forceUpgrade };
if (!modes[mode]) {
  process.stderr.write(`unknown mode ${mode}\n`);
  process.exit(64);
}
try {
  await modes[mode](args);
} catch (error) {
  process.stderr.write(`${mode} failed: ${error.code ?? ""} ${error.message}\n`);
  process.exit(1);
}
