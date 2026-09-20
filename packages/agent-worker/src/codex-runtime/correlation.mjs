/**
 * Correlation tags for unknown-submission recovery.
 *
 * Prefer schema-supported `clientUserMessageId` on turn/start when it survives
 * thread/read (as userMessage.clientId). Otherwise use a reviewed machine-
 * readable input preamble and prove it does not contaminate the assistant
 * result.
 */

import { createHash } from "node:crypto";

const TAG_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const PREAMBLE_RE = /^\[\[triangle-corr:([A-Za-z0-9._:-]{8,128})\]\]\n/;

function createCodedError(code, message, extra = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

/**
 * Bounded, non-secret correlation tag derived from profile / delivery / epoch.
 */
export function buildCorrelationTag({
  profileInstanceId,
  deliveryId,
  executionEpoch,
} = {}) {
  if (typeof profileInstanceId !== "string" || !/^[a-f0-9]{64}$/.test(profileInstanceId)) {
    throw createCodedError("correlation_invalid", "profileInstanceId must be a 64-hex instance id");
  }
  if (!Number.isSafeInteger(deliveryId) || deliveryId < 1) {
    throw createCodedError("correlation_invalid", "deliveryId must be a positive integer");
  }
  if (!Number.isSafeInteger(executionEpoch) || executionEpoch < 1) {
    throw createCodedError("correlation_invalid", "executionEpoch must be a positive integer");
  }
  const digest = createHash("sha256")
    .update("triangle-corr-v1")
    .update("\0")
    .update(profileInstanceId)
    .update("\0")
    .update(String(deliveryId))
    .update("\0")
    .update(String(executionEpoch))
    .digest("hex")
    .slice(0, 24);
  return `tc1:${digest}`;
}

export function assertCorrelationTag(tag) {
  if (typeof tag !== "string" || !TAG_PATTERN.test(tag)) {
    throw createCodedError("correlation_invalid", "correlation tag is invalid");
  }
  return tag;
}

export function buildCorrelationPreamble(tag) {
  const safe = assertCorrelationTag(tag);
  return `[[triangle-corr:${safe}]]\n`;
}

/**
 * Attach correlation to turn/start params.
 *
 * @param {"metadata"|"preamble"} mode
 */
export function attachCorrelationToTurnStart(params, tag, { mode = "metadata" } = {}) {
  if (!params || typeof params !== "object") {
    throw createCodedError("correlation_invalid", "turn/start params are required");
  }
  const safe = assertCorrelationTag(tag);
  const input = Array.isArray(params.input) ? [...params.input] : [];

  if (mode === "metadata") {
    return Object.freeze({
      ...params,
      clientUserMessageId: safe,
      input,
    });
  }

  if (mode !== "preamble") {
    throw createCodedError("correlation_invalid", `unknown correlation mode ${mode}`);
  }

  const preamble = buildCorrelationPreamble(safe);
  const nextInput = [
    {
      type: "text",
      text:
        `${preamble}` +
        "Machine correlation marker for Triangle recovery. " +
        "Do not mention, quote, or transform this marker in your assistant reply.",
    },
    ...input,
  ];
  return Object.freeze({
    ...params,
    input: nextInput,
  });
}

/**
 * Prefer metadata field when the caller has proved survival; otherwise preamble.
 */
export function selectCorrelationMode({ metadataFieldSurvivesThreadRead = false } = {}) {
  return metadataFieldSurvivesThreadRead ? "metadata" : "preamble";
}

export function extractCorrelationFromThreadRead(threadReadResult, expectedTag = null) {
  const turns = threadReadResult?.thread?.turns;
  if (!Array.isArray(turns)) return null;

  for (let t = turns.length - 1; t >= 0; t -= 1) {
    const items = turns[t]?.items;
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      if (item?.type === "userMessage" && typeof item.clientId === "string") {
        if (expectedTag == null || item.clientId === expectedTag) {
          return Object.freeze({
            source: "clientUserMessageId",
            tag: item.clientId,
            turnId: turns[t].id ?? null,
          });
        }
      }
      if (item?.type === "userMessage" && Array.isArray(item.content)) {
        for (const part of item.content) {
          if (part?.type === "text" && typeof part.text === "string") {
            const match = PREAMBLE_RE.exec(part.text);
            if (match) {
              const tag = match[1];
              if (expectedTag == null || tag === expectedTag) {
                return Object.freeze({
                  source: "input-preamble",
                  tag,
                  turnId: turns[t].id ?? null,
                });
              }
            }
          }
        }
      }
    }
  }
  return null;
}

/**
 * Collect assistant message texts from a thread/read payload and assert the
 * correlation preamble / tag did not contaminate the assistant result.
 */
export function extractAssistantTexts(threadReadResult) {
  const texts = [];
  const turns = threadReadResult?.thread?.turns;
  if (!Array.isArray(turns)) return texts;
  for (const turn of turns) {
    for (const item of turn.items ?? []) {
      if (item?.type === "agentMessage" && typeof item.text === "string") {
        texts.push(item.text);
      }
    }
  }
  return texts;
}

export function assertAssistantResultUncontaminated(threadReadResult, tag) {
  const safe = assertCorrelationTag(tag);
  const preamble = buildCorrelationPreamble(safe).trim();
  const texts = extractAssistantTexts(threadReadResult);
  for (const text of texts) {
    if (text.includes(preamble) || text.includes(`[[triangle-corr:${safe}]]`) || text.includes(safe)) {
      throw createCodedError(
        "correlation_contaminated_assistant",
        "correlation marker leaked into assistant result",
        { tag: safe },
      );
    }
  }
  return texts;
}

/**
 * Default Phase 0 bounded thread/read window once a tag or turn id is known.
 * Live tuning remains a Mini evidence question (design Phase 0 Q4).
 */
export const DEFAULT_THREAD_READ_RECONCILE_WINDOW = Object.freeze({
  maxTurns: 8,
  includeTurns: true,
  rationale:
    "Phase 0 default: inspect the most recent 8 turns for correlation tag or known turn id. Mini must confirm sufficiency against live App Server history pagination.",
});
