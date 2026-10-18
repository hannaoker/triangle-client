// Ed25519 key handling with node:crypto only. Private keys are kept as JWK
// ({crv, kty, x, d}); public keys as the canonical {crv, kty, x}.
import crypto from "node:crypto";

import { canonicalJson } from "./canonical.mjs";

export function generateEd25519() {
  const { privateKey } = crypto.generateKeyPairSync("ed25519");
  return privateJwkFromKeyObject(privateKey);
}

function privateJwkFromKeyObject(privateKey) {
  const jwk = privateKey.export({ format: "jwk" });
  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || !jwk.d || !jwk.x) throw new TypeError("not an Ed25519 key");
  return Object.freeze({ crv: "Ed25519", kty: "OKP", x: jwk.x, d: jwk.d });
}

export function publicJwk(privateJwk) {
  return Object.freeze({ crv: "Ed25519", kty: "OKP", x: privateJwk.x });
}

export function assertPrivateJwk(value) {
  if (
    !value || typeof value !== "object" || value.kty !== "OKP" || value.crv !== "Ed25519" ||
    typeof value.x !== "string" || typeof value.d !== "string" ||
    Buffer.from(value.x, "base64url").length !== 32 || Buffer.from(value.d, "base64url").length !== 32
  ) {
    throw new TypeError("invalid Ed25519 private JWK");
  }
  // Refuse a JWK whose x does not belong to d.
  const derived = privateJwkFromKeyObject(crypto.createPrivateKey({ key: { ...value }, format: "jwk" }));
  if (derived.x !== value.x) throw new TypeError("Ed25519 private JWK x does not match d");
  return Object.freeze({ crv: "Ed25519", kty: "OKP", x: value.x, d: value.d });
}

function keyObject(privateJwk) {
  return crypto.createPrivateKey({ key: { kty: "OKP", crv: "Ed25519", x: privateJwk.x, d: privateJwk.d }, format: "jwk" });
}

/** base64url Ed25519 signature over bytes. */
export function signBytes(privateJwk, bytes) {
  return crypto.sign(null, Buffer.from(bytes), keyObject(privateJwk)).toString("base64url");
}

export function verifyBytes(publicJwkValue, bytes, signature) {
  const key = crypto.createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: publicJwkValue.x }, format: "jwk" });
  return crypto.verify(null, Buffer.from(bytes), key, Buffer.from(signature, "base64url"));
}

/** RFC 7638 thumbprint of an Ed25519 public JWK. */
export function jwkThumbprint(publicJwkValue) {
  const members = canonicalJson({ crv: "Ed25519", kty: "OKP", x: publicJwkValue.x });
  return crypto.createHash("sha256").update(members, "utf8").digest("base64url");
}

/** Compact JWS with canonical JSON header and payload (the server parses strictly). */
export function compactJws(header, payload, privateJwk) {
  const input = `${Buffer.from(canonicalJson(header)).toString("base64url")}.${Buffer.from(canonicalJson(payload)).toString("base64url")}`;
  return `${input}.${signBytes(privateJwk, Buffer.from(input, "ascii"))}`;
}

export function sha256Hex(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

export function randomHex(bytes = 16) {
  return crypto.randomBytes(bytes).toString("hex");
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}

/** Human-comparable device fingerprint; matches the server's controllerFingerprint. */
export function fingerprint(jkt) {
  return jkt.slice(0, 16).toUpperCase().match(/.{4}/g).join("-");
}
