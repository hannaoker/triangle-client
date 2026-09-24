/**
 * Deterministic unattended answers for ACP server→client requests.
 *
 * Phase 0 pinned:
 * - session/request_permission → selected allow-once (or reject-once fail-closed)
 * - cursor/ask_question → skipped
 * - cursor/create_plan → rejected
 *
 * Unanswered blocking callbacks hang the turn; this module must always answer.
 */

import {
  ACP_PERMISSION_OPTION_IDS,
  ACP_SERVER_REQUEST_METHODS,
} from "./acp-protocol.mjs";

const HANDLED = new Set(ACP_SERVER_REQUEST_METHODS);

function createCodedError(code, message, extra = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

/**
 * @typedef {"allow-once" | "allow-always" | "reject-once"} PermissionDefault
 */

/**
 * @param {object} [options]
 * @param {PermissionDefault} [options.permissionDefault]
 * @param {string} [options.askQuestionReason]
 * @param {string} [options.createPlanReason]
 */
export function createUnattendedAcpPolicy({
  permissionDefault = "allow-once",
  askQuestionReason = "triangle-unattended-skip",
  createPlanReason = "triangle-unattended-reject",
} = {}) {
  if (!ACP_PERMISSION_OPTION_IDS.includes(permissionDefault)) {
    throw createCodedError(
      "acp_permission_default_invalid",
      `permissionDefault must be one of ${ACP_PERMISSION_OPTION_IDS.join(", ")}`,
    );
  }

  function answerRequestPermission(params = {}) {
    const options = Array.isArray(params?.options) ? params.options : [];
    const optionIds = options
      .map((option) => option?.optionId ?? option?.id)
      .filter((id) => typeof id === "string");
    const selected =
      optionIds.includes(permissionDefault)
        ? permissionDefault
        : optionIds.includes("allow-once")
          ? "allow-once"
          : optionIds.includes("reject-once")
            ? "reject-once"
            : permissionDefault;
    return Object.freeze({
      outcome: {
        outcome: "selected",
        optionId: selected,
      },
    });
  }

  function answerAskQuestion() {
    return Object.freeze({
      outcome: {
        outcome: "skipped",
        reason: askQuestionReason,
      },
    });
  }

  function answerCreatePlan() {
    return Object.freeze({
      outcome: {
        outcome: "rejected",
        reason: createPlanReason,
      },
    });
  }

  /**
   * @param {string} method
   * @param {object} [params]
   * @returns {{ result: object } | null} null when method is not a blocking ACP request
   */
  function answer(method, params = {}) {
    if (typeof method !== "string" || !HANDLED.has(method)) return null;
    if (method === "session/request_permission") {
      return Object.freeze({ result: answerRequestPermission(params) });
    }
    if (method === "cursor/ask_question") {
      return Object.freeze({ result: answerAskQuestion(params) });
    }
    if (method === "cursor/create_plan") {
      return Object.freeze({ result: answerCreatePlan(params) });
    }
    throw createCodedError("acp_unattended_unhandled", `no unattended answer for ${method}`);
  }

  return Object.freeze({
    permissionDefault,
    askQuestionReason,
    createPlanReason,
    handles: (method) => HANDLED.has(method),
    answer,
    answerRequestPermission,
    answerAskQuestion,
    answerCreatePlan,
  });
}
