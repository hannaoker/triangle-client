export class LocalMessagingError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = "LocalMessagingError";
    this.code = code;
  }
}

export function coded(code, message) {
  return new LocalMessagingError(code, message);
}

const REDACTION_PATTERNS = [
  /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi,
  /secret[a-zA-Z0-9_\-=:]+/gi,
  /token[a-zA-Z0-9_\-=:]+/gi,
];

export function sanitizeError(err) {
  if (!err) return { code: "unknown_error", message: "An unexpected error occurred" };
  const code = typeof err.code === "string" && /^[a-z0-9_]{1,64}$/.test(err.code)
    ? err.code
    : "internal_error";
  let message = typeof err.message === "string" ? err.message : code;
  for (const pattern of REDACTION_PATTERNS) {
    message = message.replace(pattern, "[REDACTED]");
  }
  return { code, message };
}
