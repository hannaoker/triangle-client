import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { canonicalJson } from "../src/canonical.mjs";
import { generateEd25519, jwkThumbprint, publicJwk, verifyBytes, fingerprint, assertPrivateJwk } from "../src/keys.mjs";
import { buildRedemption, parseInviteLink, redemptionMessage, revisionFromEtag, agentDraft, canonicalOrigin } from "../src/protocol.mjs";
import { createTransport, loadTransportHeaders } from "../src/transport.mjs";
import { MeshApiError, describeMeshError } from "../src/errors.mjs";
import { openCustody } from "../src/custody.mjs";

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "triangle-test-"));

test("canonical JSON sorts keys, keeps arrays, refuses floats/undefined/non-plain values", () => {
  assert.equal(canonicalJson({ b: 1, a: [true, null, "x"], c: { z: 1, y: "é" } }), '{"a":[true,null,"x"],"b":1,"c":{"y":"é","z":1}}');
  assert.throws(() => canonicalJson({ a: 1.5 }));
  assert.throws(() => canonicalJson({ a: undefined }));
  assert.throws(() => canonicalJson(new Date()));
  const cyclic = {}; cyclic.self = cyclic;
  assert.throws(() => canonicalJson(cyclic));
});

test("keys: Ed25519 JWK round trip, thumbprint and fingerprint shape, mismatched x refused", () => {
  const key = generateEd25519();
  assert.equal(jwkThumbprint(publicJwk(key)).length, 43);
  assert.match(fingerprint(jwkThumbprint(publicJwk(key))), /^[A-Z0-9_-]{4}(-[A-Z0-9_-]{4}){3}$/);
  const other = generateEd25519();
  assert.throws(() => assertPrivateJwk({ ...key, x: other.x }), /does not match/);
});

test("invite links: strict parse; secret only in the fragment; https only", () => {
  const id = `invite_${"a".repeat(32)}`;
  const secret = "s".repeat(43);
  assert.deepEqual({ ...parseInviteLink(`https://mesh.example.com/join#${id}.${secret}`) }, { authority: "https://mesh.example.com", inviteId: id, secret });
  for (const bad of [`http://mesh.example.com/join#${id}.${secret}`, `https://mesh.example.com/x#${id}.${secret}`, `https://mesh.example.com/join?x=1#${id}.${secret}`, `https://mesh.example.com/join#${id}`, "nonsense"]) {
    assert.throws(() => parseInviteLink(bad), TypeError, bad);
  }
  assert.throws(() => canonicalOrigin("https://u:p@mesh.example.com"));
});

test("redemption: owner and workload sign the same canonical message bound to the nonce", () => {
  const ownerKey = generateEd25519();
  const workloadKey = generateEd25519();
  const challenge = { challenge_id: `invite_challenge_${"0".repeat(32)}`, nonce_sha256: "ab".repeat(32) };
  const agent = agentDraft({ handle: "jerry-mini", name: "Jerry", workloadKey });
  const body = buildRedemption({ authority: "https://m.test", inviteId: `invite_${"1".repeat(32)}`, secret: "s".repeat(43), challenge, ownerKey, deviceLabel: "Mini", displayName: "Jerry", agent, workloadKey });
  const message = redemptionMessage(body, challenge.nonce_sha256);
  assert.ok(verifyBytes(publicJwk(ownerKey), message, body.owner_proof));
  assert.ok(verifyBytes(publicJwk(workloadKey), message, body.workload_proof));
  assert.ok(!verifyBytes(publicJwk(ownerKey), redemptionMessage(body, "cd".repeat(32)), body.owner_proof), "bound to the nonce");
  assert.equal(JSON.stringify(body).includes(ownerKey.d), false, "no private key material in the request");
  assert.equal(JSON.stringify(body).includes(workloadKey.d), false);
});

test("agent drafts enforce the server's handle/name rules and default permissions", () => {
  const workloadKey = generateEd25519();
  assert.deepEqual(agentDraft({ handle: "abc", name: "A", workloadKey }).permissions, { permissions_version: 1, "dm.receive": true, "dm.send": true, "posts.publish": false, "tasks.claim": false, "directory.listed": true });
  for (const handle of ["ab", "Abc", "1abc", "a--b", "a-", "x".repeat(33)]) assert.throws(() => agentDraft({ handle, name: "A", workloadKey }), TypeError, handle);
  assert.throws(() => agentDraft({ handle: "abc", name: " A", workloadKey }));
});

test("ETag → revision accepts weak and strong forms only", () => {
  assert.equal(revisionFromEtag('W/"7"'), 7);
  assert.equal(revisionFromEtag('"12"'), 12);
  assert.equal(revisionFromEtag("7"), null);
  assert.equal(revisionFromEtag(null), null);
});

test("errors: permission_denied names the key and the fix; other codes are plain", () => {
  const message = describeMeshError({ status: 403, code: "permission_denied", permission: "posts.publish" });
  assert.match(message, /Post to the team feed/);
  assert.match(message, /triangle permissions set <agent> posts\.publish=on/);
  assert.match(describeMeshError({ status: 403, code: "agent_paused" }), /paused/);
  assert.equal(new MeshApiError({ status: 403, code: "permission_denied", permission: "dm.send" }).toJSON().permission, "dm.send");
});

test("transport: --via is accepted only when its /authority names the link's authority", async () => {
  const fetchImpl = async (url) => new Response(JSON.stringify({ authority: url.startsWith("https://good.test") ? "https://mesh.test" : "https://other.test" }), { status: 200 });
  await createTransport({ authority: "https://mesh.test", via: "https://good.test", fetchImpl }).verifyAuthority();
  await assert.rejects(createTransport({ authority: "https://mesh.test", via: "https://evil.test", fetchImpl }).verifyAuthority(), (e) => e.code === "authority_mismatch");
});

test("transport headers file: must be 0600 and cannot inject auth headers; only sent to a --via transport", async () => {
  const dir = tmp();
  const file = path.join(dir, "h.json");
  writeFileSync(file, JSON.stringify({ "x-vercel-protection-bypass": "secret" }), { mode: 0o644 });
  chmodSync(file, 0o644);
  assert.throws(() => loadTransportHeaders(file), /chmod 600/);
  chmodSync(file, 0o600);
  assert.deepEqual(loadTransportHeaders(file), { "x-vercel-protection-bypass": "secret" });
  writeFileSync(file, JSON.stringify({ Authorization: "Bearer x" }));
  chmodSync(file, 0o600);
  assert.throws(() => loadTransportHeaders(file), /not allowed/);
  const seen = [];
  const fetchImpl = async (url, init) => { seen.push(init.headers); return new Response("{}", { status: 200 }); };
  await createTransport({ authority: "https://mesh.test", headers: { "x-test": "1" }, fetchImpl }).request("GET", "/x");
  assert.equal(seen[0]["x-test"], undefined, "no extra headers to the canonical authority");
  await createTransport({ authority: "https://mesh.test", via: "https://preview.test", headers: { "x-test": "1" }, fetchImpl }).request("GET", "/x");
  assert.equal(seen[1]["x-test"], "1");
});

test("custody: 0700 dirs, 0600 secrets, refuses overwrite of the owner key and group-readable keys", () => {
  const custody = openCustody(path.join(tmp(), "home")).init();
  const key = generateEd25519();
  custody.writeOwnerKey(key);
  assert.throws(() => custody.writeOwnerKey(generateEd25519()), /refusing to overwrite/);
  const file = path.join(custody.root, "owner", "owner-key.json");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(custody.root).mode & 0o777, 0o700);
  assert.deepEqual(custody.auditModes(), []);
  chmodSync(file, 0o640);
  assert.throws(() => custody.readOwnerKey(), /readable by other users/);
  assert.equal(readdirSync(path.join(custody.root, "owner")).some((f) => f.includes(".tmp-")), false);
  assert.equal(readFileSync(file, "utf8").includes(key.d), true);
});
