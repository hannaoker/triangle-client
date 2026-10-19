// HTTP to one MESH authority. The authority (canonical origin) is what every
// signature names; the transport base is where bytes go. They differ only with
// an explicit --via override, which is accepted only after GET /api/v1/authority
// at that transport returns the same authority (§3.1).
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";

import { MeshApiError, OutcomeUnknownError } from "./errors.mjs";
import { canonicalOrigin } from "./protocol.mjs";

const MAX_BODY_BYTES = 1024 * 1024;
const AUTHORITY_PATH = "/api/v1/authority";
const HEADER_NAME = /^[a-z0-9-]{1,64}$/;
const FORBIDDEN_EXTRA = new Set(["authorization", "dpop", "mesh-owner-proof", "content-type", "host", "cookie"]);

/**
 * Extra headers for a --via transport (for example a Vercel deployment-protection
 * bypass on a Preview URL). The file must be a private (0600) JSON object; auth
 * headers cannot be injected this way.
 */
export function loadTransportHeaders(file) {
  if (!file) return {};
  const link = lstatSync(file, { throwIfNoEntry: false });
  if (!link) throw new TypeError("TRIANGLE_TRANSPORT_HEADERS_FILE does not exist");
  if (!link.isFile()) throw new TypeError("TRIANGLE_TRANSPORT_HEADERS_FILE must be a regular file (not a symlink)");
  let text;
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(fd);
    if (stat.uid !== process.getuid?.()) throw new TypeError("TRIANGLE_TRANSPORT_HEADERS_FILE is not owned by this user");
    if ((stat.mode & 0o077) !== 0) throw new TypeError("TRIANGLE_TRANSPORT_HEADERS_FILE must not be readable by group or others (chmod 600).");
    if (stat.size > 64 * 1024) throw new TypeError("TRIANGLE_TRANSPORT_HEADERS_FILE is too large");
    text = readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new TypeError("transport headers file is not valid JSON"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new TypeError("transport headers file must be a JSON object");
  const headers = {};
  for (const [rawName, value] of Object.entries(parsed)) {
    const name = rawName.toLowerCase();
    if (!HEADER_NAME.test(name) || FORBIDDEN_EXTRA.has(name) || typeof value !== "string" || /[\r\n]/.test(value)) {
      throw new TypeError(`transport header ${rawName} is not allowed`);
    }
    headers[name] = value;
  }
  return headers;
}

async function readBoundedJson(response) {
  const reader = response.body?.getReader?.();
  if (!reader) return null;
  const chunks = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      throw Object.assign(new Error("response too large"), { tooLarge: true });
    }
    chunks.push(value);
  }
  if (!total) return null;
  const text = Buffer.concat(chunks).toString("utf8");
  try { return JSON.parse(text); } catch { return null; }
}

export function createTransport({ authority, via = null, headers = {}, fetchImpl = globalThis.fetch, timeoutMs = 20_000, allowLoopbackHttp = false }) {
  const canonicalAuthority = canonicalOrigin(authority, { allowLoopbackHttp });
  const base = via ? canonicalOrigin(via, { allowLoopbackHttp }) : canonicalAuthority;
  const extra = via ? { ...headers } : {};
  let verified = via ? null : Promise.resolve();

  function url(path) {
    if (!path.startsWith("/")) throw new TypeError("path must be absolute");
    return `${base}${path}`;
  }

  /**
   * One request. Returns {status, etag, body}. 2xx and 304 resolve; other
   * statuses throw MeshApiError. Network failures, timeouts and 5xx on a
   * mutating request throw OutcomeUnknownError (the caller replays its stored request).
   */
  async function request(method, path, { body, headers: requestHeaders = {}, mutating = method !== "GET" } = {}) {
    // A --via transport must prove it serves this authority before anything
    // signed or secret is sent to it (every session, including resumes).
    if (path !== AUTHORITY_PATH) {
      verified ??= verifyAuthority().catch((error) => { verified = null; throw error; });
      await verified;
    }
    return send(method, path, { body, requestHeaders, mutating });
  }

  async function send(method, path, { body, requestHeaders, mutating }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(url(path), {
        method,
        redirect: "manual",
        cache: "no-store",
        signal: controller.signal,
        headers: {
          accept: "application/json",
          ...extra,
          ...requestHeaders,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      clearTimeout(timer);
      if (mutating) throw new OutcomeUnknownError(`No response from ${base} (${error?.name === "AbortError" ? "timed out" : "network error"}).`, { cause: error });
      throw new MeshApiError({ status: 0, code: "network_error", serverMessage: `Cannot reach ${base}.`, path });
    }
    try {
      let payload;
      try {
        payload = response.status === 304 ? null : await readBoundedJson(response);
      } catch (error) {
        // The status line arrived but the body did not. For a mutation that may
        // have committed (2xx/5xx), the outcome is unknown: keep the journal.
        const refused = response.status >= 300 && response.status < 500;
        if (mutating && !refused) throw new OutcomeUnknownError(`The response from ${base} was cut off${error?.tooLarge ? " (too large)" : ""}; the change may or may not have been applied.`, { cause: error });
        throw new MeshApiError({ status: response.status, code: error?.tooLarge ? "response_too_large" : "network_error", serverMessage: `Unreadable response from ${base}.`, path });
      }
      const etag = response.headers.get("etag");
      if ((response.status >= 200 && response.status < 300) || response.status === 304) {
        return { status: response.status, etag, body: payload };
      }
      if (mutating && response.status >= 500) {
        throw new OutcomeUnknownError(`MESH answered HTTP ${response.status}${payload?.error ? ` (${payload.error})` : ""}; the change may or may not have been applied.`);
      }
      throw new MeshApiError({
        status: response.status,
        code: typeof payload?.error === "string" ? payload.error : null,
        permission: typeof payload?.permission === "string" ? payload.permission : null,
        serverMessage: typeof payload?.message === "string" ? payload.message : null,
        path,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /** Refuse a transport whose /api/v1/authority does not name this authority. */
  async function verifyAuthority() {
    const { body } = await send("GET", AUTHORITY_PATH, { requestHeaders: {}, mutating: false });
    if (!body || body.authority !== canonicalAuthority) {
      throw new MeshApiError({ status: 200, code: "authority_mismatch", serverMessage: `${base} does not serve the MESH authority ${canonicalAuthority}.` });
    }
    return body;
  }

  async function verifyOnce() {
    verified ??= verifyAuthority().catch((error) => { verified = null; throw error; });
    return verified;
  }

  return Object.freeze({ authority: canonicalAuthority, base, url, request, verifyAuthority: verifyOnce });
}
