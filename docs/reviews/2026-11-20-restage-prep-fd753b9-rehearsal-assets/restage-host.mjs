#!/usr/bin/env node
// Restage prep rehearsal helper. Always started by the rehearsal driver (or tooling tests) using a
// runtime bundle's OWN node binary, importing modules strictly from that bundle's packages/agent-worker/src/.
//
// Modes:
//   prepare <bundle> <specFile>
//   run <bundle> <configPath> [--omit-runners p1,p2] [--notices-file FILE]
//   seed-queued <bundle> <stateRoot> <sender> <recipient> <messageId> <requestId> <text>
//   journal-check <bundle> <stateRoot> <messageId>
//   journal-reply-guard <bundle> <scratchStateRoot> <sender> <recipient>
//   server-reply-guard <bundle> <scratchStateRoot> <sender> <recipient>
//   grok-send <bundle> <configPath> <alias> <to> <messageId> <requestId> [text]
//   probe-m1 <bundle> <configPath> <workspace> <rheaPrincipal> <noraPrincipal>
//   probe-m2-m3 <bundle> <configPath> <workspace> <identityRoot> <rheaPrincipal>
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";

const [mode, bundleArg, ...args] = process.argv.slice(2);
if (!mode || !bundleArg) {
  process.stderr.write("usage: restage-host.mjs <mode> <bundleRoot> ...\n");
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
    binding_id: `bind_${hex(`restage:bind:${profile}`, 32)}`,
    trust_mode: "mesh-managed",
    principal_id: `agent_${hex(`restage:agent:${profile}`, 32)}`,
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

  const senderId = hex("restage rehearsal desktop sender");
  const configPath = path.join(clientRoot, "local-messaging.json");
  const bindingPath = path.join(clientRoot, "desktop-binding.json");
  if (!fs.existsSync(bindingPath)) {
    broker.writePrivateJson(bindingPath, { instanceId: senderId, threadId: "restage-thread-0001", enabled: false });
  }
  cli.setupLocalMessaging({
    config: configPath,
    "desktop-binding": bindingPath,
    "thread-id": "restage-thread-0001",
    "state-root": stateRoot,
    recipients: local,
  });
  let realWorkspace = null;
  if (spec.workspace && spec.localCli) {
    fs.mkdirSync(spec.workspace, { recursive: true, mode: 0o700 });
    fs.chmodSync(spec.workspace, 0o700);
    realWorkspace = fs.realpathSync(spec.workspace);
    cli.setupSessionDiscovery({ config: configPath, workspace: realWorkspace, "local-cli": spec.localCli });
    cli.setupWorkspaceMessaging({ config: configPath, workspace: realWorkspace, "local-cli": spec.localCli });
  }
  cli.setupRouter({ enable: true, registryRoot, stateRoot });
  if (spec.replyIdentity === true) {
    broker.writePrivateJson(path.join(path.dirname(configPath), "reply-identity.json"), { version: 1, enabled: true });
  }

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
    sequence = existing.registry.sequence;
    for (const profile of new Set([...local, ...bound])) {
      const binding = Object.values(existing.registry.bindings).find((b) => b.profile_name === profile && b.revoked_at === null);
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
    if (spec.v2 === true) {
      registry.updateIdentityRegistry({
        root: registryRoot,
        expectedSequence: sequence,
        action: "upgrade",
        subject: null,
        mutate: (r) => registry.upgradeRegistryV1ToV2(r),
      });
      sequence += 1;
    }
    if (spec.alias) {
      const targetPrincipal = principals[spec.alias.targetProfile];
      registry.setIdentityAlias({ root: registryRoot, expectedSequence: sequence, alias: spec.alias.name, principalId: targetPrincipal });
      sequence += 1;
    }
    if (spec.destination) {
      const targetPrincipal = principals[spec.destination.targetProfile];
      const destWs = fs.realpathSync(spec.destination.workspace ?? realWorkspace);
      registry.setIdentityDestination({
        root: registryRoot,
        expectedSequence: sequence,
        principalId: targetPrincipal,
        harness: spec.destination.harness ?? "claude",
        workspace: destWs,
      });
      sequence += 1;
    }
    for (const profile of new Set([...local, ...bound])) {
      principals[profile] ??= null;
      instances[profile] = primitives.deriveClientInstanceId(profile);
    }
  }
  out({
    ok: true,
    configPath,
    stateRoot: config.stateRoot,
    workspace: realWorkspace,
    senderId,
    sequence,
    principals,
    instances,
    registryWasInPlace: existing.state === "ok",
  });
}

async function runHost([configPath, ...rest]) {
  let omitProfiles = new Set();
  let noticesFile = null;
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === "--omit-runners" && rest[i + 1] !== undefined) {
      omitProfiles = new Set(rest[i + 1].split(",").map((s) => s.trim()).filter(Boolean));
      i += 1;
    } else if (rest[i] === "--notices-file" && rest[i + 1] !== undefined) {
      noticesFile = rest[i + 1];
      i += 1;
    }
  }
  const hostModule = await load("local-messaging-host.mjs");
  const { createProfiledReasonerGate } = await load("concurrency-gate.mjs");
  const config = hostModule.loadLocalMessagingConfig(configPath);
  const runners = new Map(
    config.recipients
      .filter((r) => !omitProfiles.has(r.profile))
      .map((r) => [
        r.instanceId,
        { run: async (request) => ({ status: "completed", text: `echo[${r.profile}]: ${request.text}` }) },
      ]),
  );
  const logger = {
    info() {},
    error() {},
    warn() {},
    notice(event, detail) {
      if (noticesFile) {
        fs.appendFileSync(noticesFile, JSON.stringify({ event, ...detail }) + "\n", { mode: 0o600 });
      }
    },
  };
  let host;
  try {
    host = hostModule.createInstalledLocalMessagingHost({
      configPath,
      runners,
      gate: createProfiledReasonerGate(),
      logger,
    });
    await host.start();
  } catch (error) {
    out({ ready: false, code: error?.code ?? null, message: String(error?.message ?? error).slice(0, 400) });
    process.exit(1);
  }
  out({ ready: true, pid: process.pid, bundleRoot, node: process.version });
  const stop = async () => {
    let code = 0;
    try {
      await host.stop();
    } catch (error) {
      process.stderr.write(`host.stop failed: ${error?.code ?? ""} ${error?.message ?? error}\n`);
      code = 1;
    }
    process.exit(code);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  setInterval(() => {}, 1 << 30);
}

async function seedQueued([stateRoot, sender, recipient, messageId, requestId, text]) {
  const { createLocalMessagingJournal } = await load("local-messaging-journal.mjs");
  const journal = createLocalMessagingJournal({ stateRoot });
  try {
    const rec = await journal.recordSend({
      sender,
      recipient,
      messageId,
      requestId,
      text,
      metadata: { _loopDepth: 1 },
    });
    out({ ok: true, messageId: rec.messageId, phase: rec.phase });
  } finally {
    await journal.close();
  }
}

async function journalCheck([stateRoot, messageId]) {
  const { createLocalMessagingJournal } = await load("local-messaging-journal.mjs");
  const journal = createLocalMessagingJournal({ stateRoot });
  try {
    const rec = await journal.getRecord(messageId);
    if (!rec) out({ found: false });
    else {
      out({
        found: true,
        messageId: rec.messageId,
        phase: rec.phase ?? null,
        reason: rec.reason ?? null,
        inReplyTo: rec.inReplyTo ?? null,
        text: rec.text ?? null,
      });
    }
  } finally {
    await journal.close();
  }
}

async function journalReplyGuard([scratchStateRoot, sender, recipient]) {
  fs.mkdirSync(scratchStateRoot, { recursive: true, mode: 0o700 });
  fs.chmodSync(scratchStateRoot, 0o700);
  const { createLocalMessagingJournal } = await load("local-messaging-journal.mjs");
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
  let journal = createLocalMessagingJournal({ stateRoot: scratchStateRoot });
  try {
    // 1. A new message must never reuse a reply's ID (`message_id_in_use`).
    await journal.recordSend({ sender, recipient, messageId: "jg-m1", requestId: "jg-r1", text: "first" });
    await journal.recordReply({ sender: recipient, recipient: sender, messageId: "jg-rep-1", requestId: "jg-r1", inReplyTo: "jg-m1", text: "ok" });
    let reuseCode = null;
    try {
      await journal.recordSend({ sender, recipient, messageId: "jg-rep-1", requestId: "jg-r2", text: "reused" });
    } catch (error) {
      reuseCode = error?.code ?? null;
    }
    if (reuseCode !== "message_id_in_use") {
      throw new Error(`expected message_id_in_use, got ${reuseCode}`);
    }
    const rep = await journal.getRecord("jg-rep-1");
    if (!rep || rep.inReplyTo !== "jg-m1" || rep.phase !== undefined) {
      throw new Error("reply record was modified or shadowed");
    }

    // 2. Current admission refuses a reply taking an existing message's ID, and exact retries stay idempotent.
    const legMsg = { sender, recipient, messageId: "jg-m2", requestId: "jg-r2", text: "orig" };
    await journal.recordSend(legMsg);
    let replyReuseCode = null;
    try {
      await journal.recordReply({ sender: recipient, recipient: sender, messageId: "jg-m2", requestId: "jg-r2", inReplyTo: "jg-m2", text: "reply same id" });
    } catch (error) {
      replyReuseCode = error?.code ?? null;
    }
    if (replyReuseCode !== "message_id_in_use") {
      throw new Error(`expected reply rejection message_id_in_use, got ${replyReuseCode}`);
    }
    const retry = await journal.recordSend(legMsg);
    if (retry?.isDuplicate !== true) {
      throw new Error("expected exact retry of original message to succeed as duplicate");
    }

    // 3. Reopening a database containing a historical message/reply ID collision still answers exact retries as duplicate.
    const histMsg = { sender, recipient, messageId: "jg-hist", requestId: "jg-r-hist", text: "historical-orig" };
    await journal.recordSend(histMsg);
    await journal.close();
    journal = null;

    const db = new DatabaseSync(path.join(scratchStateRoot, "local-messaging.sqlite"));
    try {
      const now = Date.now();
      db.prepare(`
        INSERT INTO local_replies (
          message_id, sender, recipient, request_id, in_reply_to, text, metadata_json, canonical_hash, consumed, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, 0, ?, ?)
      `).run("jg-hist", recipient, sender, "jg-r-hist", "jg-hist", "historical-collision-reply", hex("historical-reply"), now, now);
    } finally {
      db.close();
    }

    journal = createLocalMessagingJournal({ stateRoot: scratchStateRoot });
    const histRetry = await journal.recordSend(histMsg);
    if (histRetry?.isDuplicate !== true) {
      throw new Error("expected exact retry of message with historical reply-id collision to succeed as duplicate");
    }

    out({
      ok: true,
      reuseCode,
      replyReuseCode,
      sameIdRetryIsDuplicate: true,
      historicalCollisionRetryIsDuplicate: true,
    });
  } finally {
    if (journal) await journal.close();
  }
}

async function grokSendRaw([configPath, alias, to, messageId, requestId, text = "raw probe"]) {
  const broker = await load("local-messaging-auth-broker.mjs");
  const grok = await load("grok-local-session.mjs");
  const clientModule = await load("local-messaging-client.mjs");
  const address = await load("local-messaging-address.mjs");
  const config = broker.readPrivateJson(configPath);
  const binding = grok.grokBindings(config).find((entry) => entry.alias === alias);
  if (!binding) throw new Error(`no Grok binding named ${alias}`);
  const client = clientModule.createLocalControlClient({
    socketPath: address.resolveLocalSocketAddress({ stateRoot: config.stateRoot }).socketPath,
    senderId: binding.senderId,
  });
  try {
    const grant = await client.exchangeInteractiveSession({
      bindingId: binding.bindingId,
      sessionId: binding.sessionId,
      generation: binding.generation,
      secret: binding.secret,
      contextHash: binding.contextHash,
    });
    try {
      const result = await client.sendMessage({ to, text, messageId, requestId }, { credential: grant.credential });
      out({ ok: true, accepted: result.accepted === true, target: result.target ?? null });
    } catch (error) {
      out({ ok: false, code: error.code ?? null, message: String(error.message).slice(0, 400) });
    }
  } finally {
    await client.close();
  }
}

async function callMcpTool(child, name, args = {}) {
  const res = await child.handleRequest({
    jsonrpc: "2.0",
    id: crypto.randomUUID(),
    method: "tools/call",
    params: { name, arguments: args },
  });
  if (res.result?.isError) return { ok: false, text: res.result.content[0].text };
  return { ok: true, value: JSON.parse(res.result.content[0].text) };
}

function routerDelta(before, after) {
  const d = {};
  for (const k of new Set([...Object.keys(before.errors), ...Object.keys(after.errors)])) {
    const v = (after.errors[k] ?? 0) - (before.errors[k] ?? 0);
    if (v !== 0) d[k] = v;
  }
  for (const k of Object.keys(after.resolved)) {
    const v = after.resolved[k] - before.resolved[k];
    if (v !== 0) d[`resolved.${k}`] = v;
  }
  return d;
}

async function probeM1([configPath, workspace, rheaPrincipal, noraPrincipal]) {
  const cli = await load("local-messaging-cli.mjs");
  const broker = await load("local-messaging-auth-broker.mjs");
  const clientMod = await load("local-messaging-client.mjs");
  const addressMod = await load("local-messaging-address.mjs");
  const mcpMod = await load("claude-session-mcp-child.mjs");
  const mappingMod = await load("local-chat-mapping.mjs");

  const config = broker.readPrivateJson(configPath);
  const desktop = broker.readPrivateJson(config.integrationPath);
  const socketPath = addressMod.resolveLocalSocketAddress({ stateRoot: config.stateRoot }).socketPath;
  const owner = clientMod.createLocalControlClient({ socketPath, senderId: desktop.senderId });
  const grant = async () => (await owner.exchangeTurnBinding({ bindingId: desktop.bindingId, threadId: desktop.threadId, secret: desktop.secret })).credential;
  const lifecycle = (sid, kind) =>
    cli.runSessionDiscoveryHook({
      configPath,
      input: Readable.from([JSON.stringify({ session_id: sid, cwd: workspace, hook_event_name: kind })]),
      stderr: { write() {} },
    });
  const children = [];
  const sids = [];
  const attachChat = async () => {
    const sid = crypto.randomUUID();
    sids.push(sid);
    await lifecycle(sid, "SessionStart");
    const child = await mcpMod.createAttachedClaudeSessionMcpChild({
      configPath,
      cwd: workspace,
      policyPath: config.sessionMessaging.integrationPath,
      expectedVersion: "2.1.307",
      env: { CLAUDE_CODE_SESSION_ID: sid },
      wakeIntervalMs: 0,
    });
    children.push(child);
    const st = await callMcpTool(child, "triangle_get_status");
    return { child, address: st.value.senderId };
  };
  let seq = 0;
  const routerOf = async () => (await owner.localStatus({ credential: await grant() })).router;
  const fromChat = async (chat, to) => {
    const before = await routerOf();
    const r = await callMcpTool(chat.child, "triangle_send_message", { to, text: "m1-probe", messageId: `m1c-${(seq += 1)}`, requestId: `m1cr-${seq}` });
    const after = await routerOf();
    return { answer: r.ok ? "accepted" : r.text.split(". To retry")[0], delta: routerDelta(before, after) };
  };
  const fromDesktop = async (to) => {
    const cred = await grant();
    const before = await routerOf();
    let answer;
    try {
      const r = await owner.sendMessage({ to, text: "m1-probe", messageId: `m1d-${(seq += 1)}` }, { credential: cred });
      answer = r.accepted ? "accepted" : JSON.stringify(r);
    } catch (error) {
      answer = `${error.code}: ${error.message}`;
    }
    const after = await routerOf();
    return { answer, delta: routerDelta(before, after) };
  };

  const mappingFile = path.join(config.stateRoot, mappingMod.CHAT_MAPPING_FILENAME);
  try {
    const X = await attachChat();
    const Y = await attachChat(); // unpermitted chat (not in allowedSenders)
    const realWs = fs.realpathSync(workspace);
    const selectorId = mappingMod.deriveChatSelectorId({ harness: "claude", workspace: realWs });
    const reset = () => fs.rmSync(mappingFile, { force: true });
    const set = () => mappingMod.setChatMapping({
      storeRoot: config.stateRoot,
      selectorId,
      harness: "claude",
      workspace: realWs,
      principalId: rheaPrincipal,
      authorityOrigin: "https://thetriangle.dev",
      bindingGeneration: 1,
    });
    const confirm = () => mappingMod.confirmChatMapping({
      storeRoot: config.stateRoot,
      selectorId,
      attachedSessions: [{ address: X.address, harness: "claude", workspace: realWs }],
    });

    const states = [
      { name: "absent", apply: () => reset(), desktopPrefix: "chat_mapping_missing", deltaKey: "chat_mapping_missing" },
      { name: "pending", apply: () => { reset(); set(); }, desktopPrefix: "chat_mapping_unconfirmed", deltaKey: "chat_mapping_unconfirmed" },
      { name: "corrupt", apply: () => { reset(); fs.writeFileSync(mappingFile, "{ broken", { mode: 0o600 }); }, desktopPrefix: "chat_mapping_corrupt", deltaKey: "chat_mapping_corrupt" },
      { name: "confirmed_online", apply: () => { reset(); set(); confirm(); }, desktopPrefix: "accepted", deltaKey: "resolved.principal" },
    ];
    for (const s of states) {
      s.apply();
      const chatToRule = await fromChat(Y, rheaPrincipal);
      const chatToNone = await fromChat(Y, noraPrincipal);
      if (!/route_unavailable/.test(chatToNone.answer) || JSON.stringify(chatToRule) !== JSON.stringify(chatToNone)) {
        throw new Error(`M1 violation at state ${s.name}: ${JSON.stringify({ chatToRule, chatToNone })}`);
      }
      const deskRule = await fromDesktop(rheaPrincipal);
      if (s.desktopPrefix === "accepted") {
        if (deskRule.answer !== "accepted" || deskRule.delta["resolved.principal"] !== 1) {
          throw new Error(`desktop confirmed send failed: ${JSON.stringify(deskRule)}`);
        }
      } else {
        if (!deskRule.answer.startsWith(`${s.desktopPrefix}:`) || deskRule.delta[s.deltaKey] !== 1) {
          throw new Error(`desktop ${s.name} mismatch: ${JSON.stringify(deskRule)}`);
        }
      }
    }
    await X.child.close();
    const deskOffline = await fromDesktop(rheaPrincipal);
    if (!deskOffline.answer.startsWith("destination_session_offline:") || deskOffline.delta.destination_session_offline !== 1) {
      throw new Error(`desktop offline mismatch: ${JSON.stringify(deskOffline)}`);
    }
    const chatOfflineRule = await fromChat(Y, rheaPrincipal);
    const chatOfflineNone = await fromChat(Y, noraPrincipal);
    if (JSON.stringify(chatOfflineRule) !== JSON.stringify(chatOfflineNone)) {
      throw new Error(`M1 offline violation: ${JSON.stringify({ chatOfflineRule, chatOfflineNone })}`);
    }
    out({ ok: true, statesChecked: 5, unauthorizedChatAnswer: "route_unavailable" });
  } finally {
    fs.rmSync(mappingFile, { force: true });
    for (const c of children) { try { await c.close(); } catch { /* closed */ } }
    for (const sid of sids) { try { await lifecycle(sid, "SessionEnd"); } catch { /* ended */ } }
    await owner.close();
  }
}

async function probeM2M3([configPath, workspace, identityRoot, rheaPrincipal]) {
  const cli = await load("local-messaging-cli.mjs");
  const broker = await load("local-messaging-auth-broker.mjs");
  const mcpMod = await load("claude-session-mcp-child.mjs");
  const sessionMod = await load("local-messaging-interactive-session.mjs");
  const mappingMod = await load("local-chat-mapping.mjs");
  const registryMod = await load("identity-registry.mjs");

  const config = broker.readPrivateJson(configPath);
  const policy = broker.readPrivateJson(config.sessionMessaging.integrationPath);
  const realWs = fs.realpathSync(workspace);
  const sidX = crypto.randomUUID();
  const sidY = crypto.randomUUID();
  const address = (sid) => sessionMod.sessionAddress(policy.installationId, policy.workspace, sessionMod.sessionAddressKey("claude", sid));
  const addrX = address(sidX);
  const addrY = address(sidY);
  const lifecycle = (sid, kind) =>
    cli.runSessionDiscoveryHook({
      configPath,
      input: Readable.from([JSON.stringify({ session_id: sid, cwd: realWs, hook_event_name: kind })]),
      stderr: { write() {} },
    });

  const mappingFile = path.join(config.stateRoot, mappingMod.CHAT_MAPPING_FILENAME);
  const children = [];
  try {
    fs.rmSync(mappingFile, { force: true });
    await lifecycle(sidX, "SessionStart");
    await lifecycle(sidY, "SessionStart");
    cli.editSessionGrant("grant-session", { config: configPath, senders: [addrX], to: addrY });

    const Y = await mcpMod.createAttachedClaudeSessionMcpChild({
      configPath,
      cwd: realWs,
      policyPath: config.sessionMessaging.integrationPath,
      expectedVersion: "2.1.307",
      env: { CLAUDE_CODE_SESSION_ID: sidY },
      wakeIntervalMs: 0,
    });
    children.push(Y);
    const stY = await callMcpTool(Y, "triangle_get_status");
    if (!stY.ok || stY.value.senderId !== addrY) throw new Error(`Y attach mismatch: ${JSON.stringify(stY)}`);
    const X = await mcpMod.createAttachedClaudeSessionMcpChild({
      configPath,
      cwd: realWs,
      policyPath: config.sessionMessaging.integrationPath,
      expectedVersion: "2.1.307",
      env: { CLAUDE_CODE_SESSION_ID: sidX },
      wakeIntervalMs: 0,
    });
    children.push(X);
    const stX = await callMcpTool(X, "triangle_get_status");
    if (!stX.ok || stX.value.senderId !== addrX) throw new Error(`X attach mismatch: ${JSON.stringify(stX)}`);

    const sendAndInspect = async (msgId) => {
      const sent = await callMcpTool(X, "triangle_send_message", { to: addrY, text: `probe-${msgId}`, messageId: msgId, requestId: `req-${msgId}` });
      if (!sent.ok) throw new Error(`send ${msgId} failed: ${sent.text}`);
      const inbox = await callMcpTool(Y, "triangle_list_inbox");
      if (!inbox.ok) throw new Error(`list_inbox failed: ${inbox.text}`);
      const item = inbox.value.items.find((m) => m.messageId === msgId);
      if (!item) throw new Error(`message ${msgId} missing in Y inbox`);
      return item.senderProvenance.principal ?? null;
    };

    const pUnmapped = await sendAndInspect("m23-unmapped");
    if (pUnmapped !== null) throw new Error(`expected null principal when unmapped, got ${pUnmapped}`);

    const selectorId = mappingMod.deriveChatSelectorId({ harness: "claude", workspace: realWs });
    const regBefore = registryMod.readIdentityRegistry({ root: identityRoot }).registry;
    const binding = Object.values(regBefore.bindings).find((b) => b.principal_id === rheaPrincipal && b.revoked_at === null);
    if (!binding) throw new Error("missing active binding for rhea");

    mappingMod.setChatMapping({
      storeRoot: config.stateRoot,
      selectorId,
      harness: "claude",
      workspace: realWs,
      principalId: rheaPrincipal,
      authorityOrigin: binding.authority_origin,
      bindingGeneration: binding.binding_generation,
    });
    const pPending = await sendAndInspect("m23-pending");
    if (pPending !== null) throw new Error(`expected null principal when pending, got ${pPending}`);

    mappingMod.confirmChatMapping({
      storeRoot: config.stateRoot,
      selectorId,
      attachedSessions: [{ address: addrX, harness: "claude", workspace: realWs }],
    });
    const pConfirmed = await sendAndInspect("m23-confirmed");
    if (pConfirmed !== rheaPrincipal) throw new Error(`expected ${rheaPrincipal} when confirmed, got ${pConfirmed}`);

    // M2: Y claims and replies to the pinned confirmed-mapped request; X receives the reply.
    const claimed = await callMcpTool(Y, "triangle_claim_message", { messageId: "m23-confirmed", claimId: "claim-m23-confirmed" });
    if (!claimed.ok || !claimed.value.claimToken) throw new Error(`claim failed: ${claimed.text}`);
    const replied = await callMcpTool(Y, "triangle_reply_message", {
      messageId: "m23-confirmed",
      claimToken: claimed.value.claimToken,
      text: "pinned-reply-ok",
      replyId: "rep-m23-confirmed",
    });
    if (!replied.ok) throw new Error(`pinned reply failed: ${replied.text}`);
    const replies = await callMcpTool(X, "triangle_get_replies", { inReplyTo: "m23-confirmed" });
    if (!replies.ok || !replies.value.replies?.some((r) => r.text === "pinned-reply-ok")) {
      throw new Error(`X did not receive pinned reply: ${JSON.stringify(replies)}`);
    }

    // M3: Revoking the binding in the registry immediately clears the sender principal on the next send.
    registryMod.updateIdentityRegistry({
      root: identityRoot,
      expectedSequence: regBefore.sequence,
      now: new Date().toISOString(),
      action: "revoke",
      subject: binding.profile_instance_id,
      mutate: (r) => {
        r.bindings[binding.profile_instance_id].revoked_at = new Date().toISOString();
        return r;
      },
    });
    const pRevoked = await sendAndInspect("m23-revoked");
    if (pRevoked !== null) throw new Error(`expected null principal after revoke, got ${pRevoked}`);

    out({
      ok: true,
      unmapped: pUnmapped,
      pending: pPending,
      confirmedPrincipal: pConfirmed,
      pinnedReplyReceived: true,
      afterRevoke: pRevoked,
    });
  } finally {
    fs.rmSync(mappingFile, { force: true });
    for (const c of children) { try { await c.close(); } catch { /* closed */ } }
    try { await lifecycle(sidX, "SessionEnd"); } catch { /* ended */ }
    try { await lifecycle(sidY, "SessionEnd"); } catch { /* ended */ }
  }
}

async function serverReplyGuard([scratchDir, sender, recipient]) {
  fs.mkdirSync(scratchDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(scratchDir, 0o700);
  const socketPath = path.join(scratchDir, "s.sock");
  const { createLocalControlServer } = await load("local-messaging-server.mjs");
  const { createLocalControlClient } = await load("local-messaging-client.mjs");

  let recordSendCalled = false;
  let rateCommitted = false;
  let rateRolledBack = false;
  const stubReplyId = "rep-guard-1";
  const server = createLocalControlServer({
    socketPath,
    stateRoot: scratchDir,
    credentialValidator: {
      validate({ expectedSenderId }) {
        return { senderId: expectedSenderId ?? sender, allowedRecipients: [recipient] };
      },
    },
    acl: {
      async checkAllowed() { return true; },
      async listAuthorizedRecipients() { return [recipient]; },
    },
    journal: {
      async getRecord(id) {
        if (id === stubReplyId) {
          return { messageId: stubReplyId, inReplyTo: "msg-orig-1", sender: recipient, recipient: sender, text: "hi" };
        }
        return null;
      },
      async recordSend() {
        recordSendCalled = true;
        return { messageId: stubReplyId, requestId: "req-guard-1", phase: "queued_local", isDuplicate: false };
      },
    },
    rateLimiter: {
      reserve() {
        return {
          commit() { rateCommitted = true; },
          rollback() { rateRolledBack = true; },
        };
      },
    },
    dispatcher: {
      async start() {},
      async stop() {},
      async notifyAdmission() {},
    },
  });

  const client = createLocalControlClient({ socketPath, senderId: sender });
  let errorCode = null;
  await server.start();
  try {
    try {
      await client.sendMessage(
        { to: recipient, text: "reuse", messageId: stubReplyId, requestId: "req-guard-1" },
        { credential: "stub-cred" },
      );
    } catch (error) {
      errorCode = error?.code ?? null;
    }
  } finally {
    await client.close();
    await server.close();
  }

  if (errorCode !== "message_id_in_use" || recordSendCalled !== false || rateRolledBack !== true || rateCommitted !== false) {
    throw new Error(
      `server reply guard mismatch: ${JSON.stringify({ errorCode, recordSendCalled, rateRolledBack, rateCommitted })}`,
    );
  }
  out({ ok: true, errorCode, recordSendCalled, rateRolledBack });
}

const modes = {
  prepare,
  run: runHost,
  "seed-queued": seedQueued,
  "journal-check": journalCheck,
  "journal-reply-guard": journalReplyGuard,
  "server-reply-guard": serverReplyGuard,
  "grok-send": grokSendRaw,
  "probe-m1": probeM1,
  "probe-m2-m3": probeM2M3,
};
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
