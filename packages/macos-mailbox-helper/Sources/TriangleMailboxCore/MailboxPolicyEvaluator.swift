import Foundation

/// Shared Swift policy evaluation for coordinator preflight and MCP list filtering.
public enum MailboxPolicyEvaluator {
    public static let ruleSetVersion = "mailbox-policy-v1"

    public struct Evaluation: Equatable, Sendable {
        public let ruleSetVersion: String
        public let protocolOwnership: MailboxTransactionProtocol
        public let open: MailboxOpenTransaction?
        public let actionable: [MailboxDeliveryCandidate]
        public let suppressedDeliveryIDs: [Int]
        public let transactionStuck: Bool
        public let shouldStartModel: Bool

        public var status: String {
            if transactionStuck { return "transaction_stuck" }
            if open != nil { return "open_transaction" }
            if actionable.isEmpty { return "empty" }
            return "actionable"
        }
    }

    public static func evaluate(
        protocolOwnership: MailboxTransactionProtocol,
        candidates: [MailboxDeliveryCandidate],
        open: MailboxOpenTransaction?,
        quarantined: [MailboxQuarantinedTransaction]
    ) throws -> Evaluation {
        if let open {
            guard open.protocolOwnership == protocolOwnership else {
                throw MailboxTransactionStoreError.protocolMismatch
            }
        }

        let quarantinedIDs = Set(
            quarantined
                .filter { $0.protocolOwnership == protocolOwnership }
                .map(\.deliveryID)
        )
        var suppressed = Array(quarantinedIDs).sorted()

        if let open {
            let stuck = open.isStuck
            // While a transaction is open, only that delivery may progress; others are not actionable.
            let matching = candidates.filter { $0.deliveryID == open.deliveryID && $0.roomID == open.roomID }
            let otherIDs = candidates.map(\.deliveryID).filter { $0 != open.deliveryID }
            suppressed = Array(Set(suppressed + otherIDs + Array(quarantinedIDs))).sorted()
            return Evaluation(
                ruleSetVersion: ruleSetVersion,
                protocolOwnership: protocolOwnership,
                open: open,
                actionable: stuck ? [] : matching,
                suppressedDeliveryIDs: suppressed,
                transactionStuck: stuck,
                shouldStartModel: !stuck && open.state != .replied
            )
        }

        let actionable = candidates.filter { !quarantinedIDs.contains($0.deliveryID) }
        return Evaluation(
            ruleSetVersion: ruleSetVersion,
            protocolOwnership: protocolOwnership,
            open: nil,
            actionable: actionable,
            suppressedDeliveryIDs: suppressed,
            transactionStuck: false,
            shouldStartModel: !actionable.isEmpty
        )
    }

    /// Defense-in-depth filter for MCP `mesh.mailbox.list` result items (metadata only).
    public static func filterListItems(
        _ items: [[String: Any]],
        evaluation: Evaluation
    ) -> [[String: Any]] {
        let suppressed = Set(evaluation.suppressedDeliveryIDs)
        return items.filter { item in
            guard let deliveryID = intValue(item["deliveryId"] ?? item["delivery_id"]) else { return false }
            if suppressed.contains(deliveryID) { return false }
            if let open = evaluation.open {
                return deliveryID == open.deliveryID
            }
            return true
        }
    }

    private static func intValue(_ value: Any?) -> Int? {
        if let int = value as? Int { return int }
        if let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() {
            return number.intValue
        }
        return nil
    }
}
