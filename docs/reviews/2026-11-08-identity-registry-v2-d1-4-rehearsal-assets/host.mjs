#!/usr/bin/env node
// D1.4 rehearsal helper. The driver (rehearsal.mjs) always starts this file with a runtime bundle's OWN node, and it
// imports modules only from that bundle, so what runs is the bundle's code and nothing from a checkout.
//
//   host.mjs prepare <bundle> <clientRoot> <stateRoot> <registryRoot> <profile>...   build a scratch client + v1 registry
//                                                                                    (a registry already in place is read, not changed)
//   host.mjs run     <bundle> <configPath>                                          the production host with echo runners
//   host.mjs read    <bundle> <registryRoot>                                        read the registry with the bundle's reader
//   host.mjs bind    <bundle> <registryRoot> <profile> <expectedSequence>           try a write with the bundle's writer
//   host.mjs force-upgrade <bundle> <registryRoot>                                  the audited v1 -> v2 write WITHOUT the
//                                                                                    floor (what the floor exists to prevent)
//
// Every mode prints one JSON line on stdout. Nothing here touches the live application root: all paths are arguments.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [mode, bundleArg, ...args] = process.argv.slice(2);
if (!mode || !bundleArg) {
  process.stderr.write("usage: host.mjs <prepare|run|read|bind|force-upgrade> <bundleRoot> ...\n");
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
    issued_at: "2026-10-25T10:00:00.000Z",
    revoked_at: null,
    proof: { kind: "disk_observation", observed_on_disk: true, verified_live_authority: false },
  };
}

async function prepare([clientRoot, stateRoot, registryRoot, ...profiles]) {
  if (![clientRoot, stateRoot, registryRoot].every((p) => path.isAbsolute(p)) || profiles.length === 0) {
    throw new Error("prepare needs absolute clientRoot, stateRoot, registryRoot and at least one profile");
  }
  const cli = await load("local-messaging-cli.mjs");
  const broker = await load("local-messaging-auth-broker.mjs");
  const registry = await load("identity-registry.mjs");
  const primitives = await load("identity-primitives.mjs");

  const senderId = hex("d1-4 rehearsal desktop sender");
  const configPath = path.join(clientRoot, "local-messaging.json");
  const bindingPath = path.join(clientRoot, "desktop-binding.json");
  broker.writePrivateJson(bindingPath, { instanceId: senderId, threadId: "rehearsal-thread-0001", enabled: false });
  cli.setupLocalMessaging({
    config: configPath,
    "desktop-binding": bindingPath,
    "thread-id": "rehearsal-thread-0001",
    "state-root": stateRoot,
    recipients: profiles,
  });
  cli.setupRouter({ enable: true, registryRoot, stateRoot });

  const config = broker.readPrivateJson(configPath);
  for (const profile of profiles) {
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
    // A registry (a copy of a real one) is already in place: read it and change nothing.
    sequence = existing.registry.sequence;
    for (const profile of profiles) {
      const binding = Object.values(existing.registry.bindings).find((b) => b.profile_name === profile);
      principals[profile] = binding?.principal_id ?? null;
      instances[profile] = binding?.profile_instance_id ?? null;
    }
  } else {
    registry.updateIdentityRegistry({ root: registryRoot, expectedSequence: 0, action: "init", subject: null, mutate: (r) => r });
    sequence = 1;
    for (const profile of profiles) {
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
      instances[profile] = binding.profile_instance_id;
    }
  }
  out({ ok: true, configPath, senderId, sequence, principals, instances, registryWasInPlace: existing.state === "ok" });
}

async function run([configPath]) {
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
    out({
      ok: true,
      state: result.state,
      schema: result.registry?.schema ?? null,
      sequence: result.registry?.sequence ?? null,
      bindings: result.registry ? Object.keys(result.registry.bindings).length : 0,
    });
  } catch (error) {
    out({ ok: false, code: error.code ?? null, message: String(error.message).slice(0, 240) });
  }
}

async function bind([registryRoot, profile, expectedSequence]) {
  const registry = await load("identity-registry.mjs");
  const primitives = await load("identity-primitives.mjs");
  const binding = makeBinding(registry, primitives, profile);
  try {
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

const modes = { prepare, run, read, bind, "force-upgrade": forceUpgrade };
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
