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

export function canonicalJson(value, seen = new Set()) {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new TypeError("canonicalJson accepts only safe integers");
    return JSON.stringify(value);
  }
  if (typeof value !== "object") throw new TypeError(`canonicalJson cannot encode ${typeof value}`);
  if (seen.has(value)) throw new TypeError("canonicalJson refuses cycles");
  seen.add(value);
  try {
    if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item, seen)).join(",")}]`;
    if (!isPlainObject(value)) throw new TypeError("canonicalJson accepts only plain objects");
    const keys = Object.keys(value).sort(compareUtf16);
    const members = [];
    for (const key of keys) {
      if (value[key] === undefined) throw new TypeError(`canonicalJson: ${key} is undefined`);
      members.push(`${JSON.stringify(key)}:${canonicalJson(value[key], seen)}`);
    }
    return `{${members.join(",")}}`;
  } finally {
    seen.delete(value);
  }
}

export function canonicalBytes(value) {
  return new TextEncoder().encode(canonicalJson(value));
}
