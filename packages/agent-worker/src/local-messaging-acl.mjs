import { coded } from "./local-messaging-errors.mjs";

export function createOwnerAcl({ rules = {} } = {}) {
  // Normalize rules into a Map<string, Set<string>>
  const aclMap = new Map();

  if (rules instanceof Map) {
    for (const [sender, recipients] of rules.entries()) {
      aclMap.set(sender, new Set(Array.isArray(recipients) ? recipients : []));
    }
  } else if (typeof rules === "object" && rules !== null) {
    for (const [sender, recipients] of Object.entries(rules)) {
      aclMap.set(sender, new Set(Array.isArray(recipients) ? recipients : []));
    }
  }

  return {
    listAuthorizedRecipients(senderId) {
      if (!senderId || !aclMap.has(senderId)) return [];
      return Array.from(aclMap.get(senderId));
    },

    isAllowed(senderId, recipientId) {
      if (!senderId || !recipientId) return false;
      const allowed = aclMap.get(senderId);
      return allowed ? allowed.has(recipientId) : false;
    },

    checkAllowed(senderId, recipientId) {
      if (!this.isAllowed(senderId, recipientId)) {
        throw coded("recipient_not_allowed", `Sender ${senderId} is not authorized to message ${recipientId}`);
      }
    },
  };
}
