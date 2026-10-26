// Identity primitives shared by the inventories, the registry, the mapping and the router.
//
// This is a leaf module: it imports only node: built-ins, so the supervisor can load the
// identity registry without also loading the installation and identity inventories.
import { createHash } from "node:crypto";

export const AGENT_ID_PATTERN = /^agent_[a-f0-9]{32}$/;
export const INSTANCE_ID_PATTERN = /^[a-f0-9]{64}$/;
export const SESSION_ID_PATTERN = /^session-[a-f0-9]{64}$/;

const PROFILE_MAX_UTF8_BYTES = 64;
// Swift `CharacterSet.controlCharacters` is Unicode general categories Cc + Cf.
const PROFILE_CONTROL_CHARACTER = /[\p{Cc}\p{Cf}]/u;

/** Mirrors Swift `ClientInstanceID.derive(profile:)`. */
export function deriveClientInstanceId(profile) {
  const hash = createHash("sha256");
  hash.update(Buffer.from("triangle-client-instance-v1", "utf8"));
  hash.update(Buffer.from([0]));
  hash.update(Buffer.from(profile, "utf8"));
  return hash.digest("hex");
}

/**
 * Persisted profile-name contract. Mirrors Swift `ProfileName.init(_:)`
 * (TriangleMailboxCore/Models.swift), which decodes every registry row:
 * non-empty, at most 64 UTF-8 bytes, no "/" or "\\", no control/format
 * characters. Case, dots, and underscores are preserved; names are never
 * normalized or renamed. The Node runtime validators (helper proxy: non-empty,
 * no NUL/"/"; Cursor ACP drain and progress journal: `[A-Za-z0-9._-]{1,64}`)
 * accept subsets of this contract, so every name they accept is accepted here.
 * Lone surrogates are rejected because they cannot be valid UTF-8 from Swift.
 */
export function isValidProfileName(value) {
  return typeof value === "string"
    && value.length > 0
    && value.isWellFormed()
    && Buffer.byteLength(value, "utf8") <= PROFILE_MAX_UTF8_BYTES
    && !value.includes("/")
    && !value.includes("\\")
    && !PROFILE_CONTROL_CHARACTER.test(value);
}

/**
 * Validates that an origin is a bare HTTPS origin:
 * - Scheme must be https://
 * - Non-empty hostname
 * - No userinfo (@)
 * - No path (not even trailing slash '/')
 * - No query (?)
 * - No fragment (#)
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isValidBareHttpsOrigin(value) {
  if (typeof value !== "string" || !value.startsWith("https://")) return false;
  // Raw path check: origin cannot have path, trailing slash, query, or hash
  const rawPath = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]*(.*)$/s.exec(value);
  if (rawPath == null || rawPath[1] !== "") return false;
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === "https:"
    && url.hostname.length > 0
    && url.username === ""
    && url.password === ""
    && !value.includes("@")
    && !value.includes("?")
    && !value.includes("#")
    && url.origin === value;
}
