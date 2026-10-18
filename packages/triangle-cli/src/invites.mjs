// Teammate and device invites (§3.2, §3.4). The client generates the secret and
// sends only its SHA-256; the link exists only in this process's output and in
// the 0600 journal entry until the server confirms the invite.
import { inviteLink } from "./protocol.mjs";
import { randomToken, sha256Hex } from "./keys.mjs";

const INVITE_ID = /^invite_[0-9a-f]{32}$/;

export async function createInvite(session, { kind, role = null, displayNameHint = null, emailHint = null, expiresInSeconds = null }) {
  if (kind !== "teammate" && kind !== "device") throw new TypeError("invite kind must be teammate or device");
  if (kind === "teammate" && role !== "admin" && role !== "member") throw new TypeError("--role must be admin or member");
  if (kind === "device" && (role !== null || displayNameHint !== null || emailHint !== null || expiresInSeconds !== null)) {
    throw new TypeError("device invites take no role, hints or expiry (they last 15 minutes)");
  }
  if (expiresInSeconds !== null && (!Number.isSafeInteger(expiresInSeconds) || expiresInSeconds < 60 || expiresInSeconds > 604800)) {
    throw new TypeError("--expires must be 60 seconds to 7 days");
  }
  const secret = randomToken(32);
  const params = {
    kind,
    role: kind === "teammate" ? role : null,
    display_name_hint: displayNameHint,
    email_hint: emailHint,
    expires_in_seconds: expiresInSeconds,
    secret_sha256: sha256Hex(secret),
  };
  return session.custody.withLock(async () => {
    const response = await session.ownerOperation("invite.create", null, params, { extra: { invite_secret: secret } });
    return inviteOutcome(session, response, secret);
  });
}

/** The link is rebuilt from the server's invite id and the locally generated secret. */
export function inviteOutcome(session, response, secret) {
  const invite = response.result;
  if (!INVITE_ID.test(invite?.invite_id ?? "")) throw new TypeError("The MESH server returned no invite id.");
  return { outcome: response.outcome, invite: { ...invite, link: inviteLink(session.transport.authority, invite.invite_id, secret) } };
}

export async function revokeInvite(session, inviteId) {
  if (!INVITE_ID.test(inviteId ?? "")) throw new TypeError("Give the invite id (invite_…) printed when it was created.");
  return session.custody.withLock(async () => (await session.ownerOperation("invite.revoke", inviteId, {})).result);
}

export function renderInvite({ outcome, invite }) {
  const lines = [];
  if (invite.kind === "device") {
    lines.push("On your other computer, run (link valid for 15 minutes, single use):", "", `  triangle join '${invite.link}'`, "");
    lines.push("It will print a fingerprint. Approve it here with `triangle device approve <fingerprint>` after checking it matches.");
  } else {
    lines.push(`Teammate invite (${invite.role})${outcome === "replayed" ? " (replayed)" : ""}. Send this link privately; anyone holding it can join once:`, "", `  ${invite.link}`, "");
    lines.push(`Expires ${invite.expires_at}. Revoke with \`triangle invite revoke ${invite.invite_id}\`.`);
  }
  return lines.join("\n");
}
