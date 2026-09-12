import Testing
import TriangleMailboxTestSupport

@Suite("Trusted mailbox transaction proxy")
struct MailboxTransactionTests {
    @Test("deterministic claim and reply identifiers")
    func deterministicIdentifiers() async throws { try await MailboxTransactionContractCases.deterministicIdentifiers() }

    @Test("exact open.json schema and ownership")
    func exactSchema() async throws { try await MailboxTransactionContractCases.exactSchemaAndOwnership() }

    @Test("one open transaction and nested claim refusal")
    func nestedClaim() async throws { try await MailboxTransactionContractCases.oneOpenAndNestedClaim() }

    @Test("room mismatch and unrelated ack refusal")
    func roomAck() async throws { try await MailboxTransactionContractCases.roomAndAckGuards() }

    @Test("reply idempotency conflict converges to replied")
    func replyConflict() async throws { try await MailboxTransactionContractCases.replyIdempotencyConflict() }

    @Test("retry with different reply text yields one room event")
    func differentText() async throws { try await MailboxTransactionContractCases.differentTextOneEvent() }

    @Test("unverified 409 without matching event refuses replied and ack")
    func unverifiedMissingEvent() async throws { try await MailboxTransactionContractCases.unverifiedConflictMissingEvent() }

    @Test("unverified 409 when history lookup fails refuses replied and ack")
    func unverifiedLookupFailure() async throws { try await MailboxTransactionContractCases.unverifiedConflictLookupFailure() }

    @Test("five failures return transaction_stuck")
    func stuck() async throws { try await MailboxTransactionContractCases.fiveFailuresStuck() }

    @Test("quarantine abandons without releasing server claim")
    func quarantine() async throws { try await MailboxTransactionContractCases.quarantineWithoutRelease() }

    @Test("wrong protocol owner is rejected")
    func protocolOwner() async throws { try await MailboxTransactionContractCases.wrongProtocolOwner() }

    @Test("malicious parameters and false room IDs")
    func malicious() async throws { try await MailboxTransactionContractCases.maliciousParameters() }

    @Test("corrupt truncate replace symlink permission faults")
    func storageFaults() async throws { try await MailboxTransactionContractCases.storageFaultInjection() }

    @Test("concurrent open of state file")
    func concurrent() async throws { try await MailboxTransactionContractCases.concurrentOpen() }

    @Test("crash before local prepare")
    func crashBeforePrepare() async throws { try await MailboxTransactionContractCases.crashBeforeLocalPrepare() }

    @Test("crash after local prepare")
    func crashAfterPrepare() async throws { try await MailboxTransactionContractCases.crashAfterLocalPrepare() }

    @Test("crash after server claim")
    func crashAfterClaim() async throws { try await MailboxTransactionContractCases.crashAfterServerClaim() }

    @Test("crash before local reply write")
    func crashBeforeReply() async throws { try await MailboxTransactionContractCases.crashBeforeLocalReplyWrite() }

    @Test("crash after reply commit")
    func crashAfterReply() async throws { try await MailboxTransactionContractCases.crashAfterReplyCommit() }

    @Test("crash before ack")
    func crashBeforeAck() async throws { try await MailboxTransactionContractCases.crashBeforeAck() }

    @Test("crash after ack")
    func crashAfterAck() async throws { try await MailboxTransactionContractCases.crashAfterAck() }

    @Test("policy evaluator filters list and preflight")
    func policy() async throws { try await MailboxTransactionContractCases.policyEvaluatorShared() }

    @Test("MCP rewriter ignores model claim and reply IDs")
    func mcpRewrite() async throws { try await MailboxTransactionContractCases.mcpRewriterIgnoresModelIDs() }

    @Test("transaction CLI parser surface")
    func parser() async throws { try await MailboxTransactionContractCases.transactionCommandParser() }

    @Test("no message content in storage or status")
    func noContent() async throws { try await MailboxTransactionContractCases.noContentInStorage() }
}
