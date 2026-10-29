import { coded } from "./local-messaging-errors.mjs";

// R0 library contract only. This module does not select routes or grant access.
export const REQUIRED_TRANSPORT_ADAPTER_METHODS = Object.freeze([
  "describe", "reach", "send", "poll", "status", "discover", "replies", "consume",
]);

export function validateTransportAdapter(adapter) {
  for (const method of REQUIRED_TRANSPORT_ADAPTER_METHODS) {
    if (typeof adapter?.[method] !== "function") {
      throw coded("invalid_transport_adapter", `Missing transport adapter method: ${method}`);
    }
  }
  return adapter;
}

// These are observations, not a progression inferred from notifications.
export function localState(phase) {
  switch (phase) {
    case "queued_local": return "received"; // Same-host journal custody only.
    case "executing": return "executing"; // Native claim, not proof the model started.
    case "held": return "held";
    case "completed": return "completed"; // Query replies separately.
    case "failed": return "failed"; // Closed by the owner without a result.
    default: return "unknown";
  }
}
