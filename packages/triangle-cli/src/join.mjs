// `triangle join <link>` (§1.1, §3.4): one action that creates this device's
// owner key, redeems the invite and (for bootstrap/teammate links) the first
// agent. Keys and the full signed request are persisted before sending; an
// unknown outcome is resolved with `triangle join --resume`, which replays the
// identical request and never generates new keys.
import os from "node:os";

import { openCustody } from "./custody.mjs";
import { LocalStateError, MeshApiError, OutcomeUnknownError } from "./errors.mjs";
import { generateEd25519, jwkThumbprint, publicJwk, fingerprint } from "./keys.mjs";
import { agentDraft, buildRedemption, parseInviteLink, truncateText } from "./protocol.mjs";
import { createTransport } from "./transport.mjs";
import { transportOptions } from "./session.mjs";

const JOURNAL = "join";

export function defaultDeviceLabel() {
  const host = truncateText(os.hostname().replace(/\.local$/, ""), 100) || "this computer";
  return host;
}

/** A canonical handle derived from the user and host, e.g. `jerry-mac-mini`. */
export function defaultHandle(seed = `${os.userInfo().username}-${os.hostname().replace(/\.local$/, "")}`) {
  let handle = seed.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^[^a-z]+/, "").replace(/-+$/, "").slice(0, 32).replace(/-+$/, "");
  if (handle.length < 3) handle = `agent-${handle || "one"}`.slice(0, 32);
  return handle;
}

function isDeviceOnlyRefusal(error) {
  return error instanceof MeshApiError && error.status === 400 && error.code === "invalid_request" && /device invite/i.test(error.message);
}

function persistResult(custody, journal, result) {
  const controller = result.controller;
  custody.writeAuthority({ authority: journal.authority, via: journal.via ?? null, joined_at: new Date().toISOString() });
  custody.writeController({
    owner_id: result.owner_id,
    owner_role: result.owner_role ?? null,
    controller_id: controller.controller_id,
    jkt: controller.jkt,
    fingerprint: controller.fingerprint,
    device_label: controller.device_label,
    state: controller.state,
    display_name: journal.body.display_name ?? null,
  });
  if (result.agent) {
    custody.writeWorkloadKey(result.agent.agent_id, journal.workload_key);
    custody.writeAgent(result.agent.agent_id, {
      agent_id: result.agent.agent_id,
      handle: result.agent.handle,
      name: result.agent.name,
      workload_id: result.agent.workload.workload_id,
      bounds: result.agent.workload.bounds,
      authority: journal.authority,
      created_at: new Date().toISOString(),
    });
  }
}

function committed(error) {
  error.committed = true;
  error.resumeHint = "triangle join --resume";
  return error;
}

async function send(custody, transport, journal) {
  let response;
  try {
    response = await transport.request("POST", `/api/v1/invites/${journal.invite_id}/redeem`, { body: journal.body });
  } catch (error) {
    if (error instanceof OutcomeUnknownError) {
      error.message = `Join outcome unknown: ${error.message} Run \`triangle join --resume\`; it replays the same request.`;
      error.resumeHint = "triangle join --resume";
    }
    throw error;
  }
  const result = response.body?.result;
  if (!result?.controller?.controller_id) throw committed(new OutcomeUnknownError("The MESH server answered without a join result. Run `triangle join --resume`."));
  try {
    persistResult(custody, journal, result);
  } catch (error) {
    // The server committed; keep the journal (it holds the keys) so
    // `triangle join --resume` can replay and finish installing.
    throw committed(new LocalStateError(`Joined, but saving this device's state failed (${error.message}). Fix the problem, then run \`triangle join --resume\`.`));
  }
  custody.removeJournal(JOURNAL);
  return { outcome: response.body.outcome, result };
}

async function signAndSend(custody, transport, journal) {
  const { body: challenge } = await transport.request("POST", `/api/v1/invites/${journal.invite_id}/challenges`, { mutating: false });
  journal.body = buildRedemption({
    authority: journal.authority,
    inviteId: journal.invite_id,
    secret: journal.invite_secret,
    challenge,
    ownerKey: journal.owner_key,
    deviceLabel: journal.device_label,
    displayName: journal.display_name,
    agent: journal.agent,
    workloadKey: journal.workload_key,
  });
  custody.writeJournal(JOURNAL, journal);
  return send(custody, transport, journal);
}

/**
 * options: {home, link, via, deviceLabel, displayName, handle, agentName, device (bool), env, fetchImpl}
 */
export async function join({ home, link, via = null, deviceLabel = defaultDeviceLabel(), displayName = null, handle, agentName, device = false, env = process.env, fetchImpl = globalThis.fetch }) {
  const custody = openCustody(home).init();
  return custody.withLock(async () => {
    if (custody.readJournal(JOURNAL)) throw new LocalStateError("A join is already in progress on this device. Run `triangle join --resume`.");
    if (custody.readController()) throw new LocalStateError(`This device already joined ${custody.readAuthority()?.authority}. Use a separate --home for another MESH.`);
    const options = transportOptions(env);
    const parsed = parseInviteLink(link, { allowLoopbackHttp: options.allowLoopbackHttp });
    const transport = createTransport({ authority: parsed.authority, via, fetchImpl, ...options });
    await transport.verifyAuthority();

    const ownerKey = custody.readOwnerKey() ?? (() => { const key = generateEd25519(); custody.writeOwnerKey(key); return key; })();
    const workloadKey = device ? null : generateEd25519();
    const agent = device ? null : agentDraft({ handle: handle ?? defaultHandle(), name: agentName ?? truncateText(`${displayName ?? os.userInfo().username}'s agent on ${deviceLabel}`, 80).trim(), workloadKey });
    const journal = {
      kind: "join",
      authority: parsed.authority,
      via: via ?? null,
      invite_id: parsed.inviteId,
      invite_secret: parsed.secret,
      device_label: deviceLabel,
      // A new owner needs a name (1-128 chars); default to the OS account name.
      display_name: device ? null : truncateText(displayName ?? defaultDisplayName(), 128),
      owner_key: ownerKey,
      workload_key: workloadKey,
      agent,
      created_at: new Date().toISOString(),
    };
    const attempt = async () => {
      try {
        return await signAndSend(custody, transport, journal);
      } catch (error) {
        if (device || !isDeviceOnlyRefusal(error)) throw error;
        // A device link adds this computer to an existing owner; it creates no agent.
        Object.assign(journal, { workload_key: null, agent: null, display_name: null });
        return signAndSend(custody, transport, journal);
      }
    };
    try {
      return await attempt();
    } catch (error) {
      // Only a definitive refusal of a request that cannot have committed frees the journal.
      if (error instanceof MeshApiError && !error.committed && error.status >= 400 && error.status < 500) custody.removeJournal(JOURNAL);
      else if (!(error instanceof OutcomeUnknownError) && !error.committed && !(error instanceof MeshApiError)) custody.removeJournal(JOURNAL);
      throw error;
    }
  });
}

/** Replay the stored join. If the first send never arrived and its challenge expired, re-sign the same keys with a fresh challenge. */
export async function resumeJoin({ home, env = process.env, fetchImpl = globalThis.fetch }) {
  const custody = openCustody(home).init();
  return custody.withLock(async () => {
    const journal = custody.readJournal(JOURNAL);
    if (!journal) throw new LocalStateError("There is no join to resume on this device.");
    const transport = createTransport({ authority: journal.authority, via: journal.via, fetchImpl, ...transportOptions(env) });
    try {
      return await send(custody, transport, journal);
    } catch (error) {
      // The server checks for an earlier redemption before the challenge, so an
      // expired/used challenge (410 challenge_invalid) means nothing committed:
      // fetch a fresh one and re-sign with the same journaled keys.
      if (error instanceof MeshApiError && (error.code === "invite_invalid" || error.code === "challenge_invalid")) {
        return signAndSend(custody, transport, journal);
      }
      throw error;
    }
  });
}

function defaultDisplayName() {
  let name = "";
  try { name = os.userInfo().username; } catch {}
  return name.trim() || "Owner";
}

export function deviceIdentity(ownerKey) {
  const jkt = jwkThumbprint(publicJwk(ownerKey));
  return { jkt, fingerprint: fingerprint(jkt) };
}
