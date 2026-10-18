// RFC 8785 (JCS) canonical JSON for the value domain MESH v1 signs: plain
// objects, arrays, strings, booleans, null and safe integers. Anything else
// (floats, non-plain objects, undefined, cycles) is refused rather than guessed,
// so a signature can never cover bytes the server would canonicalize differently.

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function compareUtf16(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** RFC 8785 §3.2.2.2: strings must be well-formed Unicode (no lone surrogates). */
function encodeString(text) {
  if (!text.isWellFormed()) throw new TypeError("canonicalJson refuses strings with lone surrogates");
  return JSON.stringify(text);
}

export function canonicalJson(value, seen = new Set()) {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "string") return encodeString(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new TypeError("canonicalJson accepts only safe integers");
    return JSON.stringify(value);
  }
  if (typeof value !== "object") throw new TypeError(`canonicalJson cannot encode ${typeof value}`);
  if (seen.has(value)) throw new TypeError("canonicalJson refuses cycles");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const items = [];
      for (let i = 0; i < value.length; i += 1) {
        if (!Object.hasOwn(value, i)) throw new TypeError("canonicalJson refuses sparse arrays");
        items.push(canonicalJson(value[i], seen));
      }
      return `[${items.join(",")}]`;
    }
    if (!isPlainObject(value)) throw new TypeError("canonicalJson accepts only plain objects");
    const keys = Object.keys(value).sort(compareUtf16);
    const members = [];
    for (const key of keys) {
      if (value[key] === undefined) throw new TypeError(`canonicalJson: ${key} is undefined`);
      members.push(`${encodeString(key)}:${canonicalJson(value[key], seen)}`);
    }
    return `{${members.join(",")}}`;
  } finally {
    seen.delete(value);
  }
}

export function canonicalBytes(value) {
  return new TextEncoder().encode(canonicalJson(value));
}
