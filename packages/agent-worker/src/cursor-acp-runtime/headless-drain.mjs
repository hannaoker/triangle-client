import { createHeadlessDrain } from "../codex-runtime/headless-drain.mjs";

const lane = {
  requiredMethods: ["runDelivery", "stop"],
  logPrefix: "triangle_cursor_acp_drain",
  blockedCode: "cursor_acp_drain_recovery_blocked",
  showPollInterval: true,
};

export function createHeadlessCursorAcpDrain(options) {
  return createHeadlessDrain(lane, options);
}
