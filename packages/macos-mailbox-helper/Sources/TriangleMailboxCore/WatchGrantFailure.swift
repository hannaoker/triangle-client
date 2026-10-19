import Foundation

/// Which watch-ensure / watch-* gate failed. Secret-free; safe for operator stderr.
public enum WatchGrantFailureGate: String, Codable, Equatable, Sendable {
    case validation
    case membership
    case workloadAuth = "workload_auth"
    case keychain
    case network
    case profile
}

/// Machine-readable watch failure codes. Never carry tokens or mesh_/mesh_watch_ material.
public enum WatchGrantFailureCode: String, Codable, Equatable, Sendable {
    case keychainUnavailable = "keychain_unavailable"
    case helperUnavailable = "helper_unavailable"
    case noEventDrivenMembers = "no_event_driven_members"
    case actorNotDeclared = "actor_not_declared"
    case interactiveDeliveryExcluded = "interactive_delivery_excluded"
    case workloadAuthUnavailable = "workload_auth_unavailable"
    case workloadKeyMissing = "workload_key_missing"
    case credentialMissing = "credential_missing"
    case invalidCursor = "invalid_cursor"
    case rejected = "watch_rejected"
    case resyncRequired = "resync_required"
    case invalidResponse = "invalid_response"
    case profileNotFound = "profile_not_found"
    case credentialInvalid = "credential_invalid"
    case credentialRefused = "credential_refused"
    case agentPaused = "agent_paused"
    case offline = "offline"
    case identityMismatch = "identity_mismatch"
    case verificationFailed = "verification_failed"
    case instanceStoreUnavailable = "instance_store_unavailable"
    case operationFailed = "operation_failed"
}

/// Structured, secret-free diagnosis for failed watch CLI operations.
public struct WatchGrantFailureDiagnosis: Codable, Equatable, Sendable,
    CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable
{
    public let status: String
    public let code: WatchGrantFailureCode
    public let gate: WatchGrantFailureGate
    public let operatorAction: WatchGrantOperatorAction
    public let safeToRetry: Bool
    public let mustNotReregister: Bool
    public let detail: String
    public let rejectedStatusCode: Int?
    public let rejectedCode: String?
    public let restartCursor: Int?
    public let operatorNotes: [String]

    private enum CodingKeys: String, CodingKey {
        case status, code, gate, operatorAction, safeToRetry, mustNotReregister, detail
        case rejectedStatusCode, rejectedCode, restartCursor, operatorNotes
    }

    public init(
        code: WatchGrantFailureCode,
        gate: WatchGrantFailureGate,
        operatorAction: WatchGrantOperatorAction,
        safeToRetry: Bool,
        mustNotReregister: Bool = true,
        detail: String,
        rejectedStatusCode: Int? = nil,
        rejectedCode: String? = nil,
        restartCursor: Int? = nil,
        operatorNotes: [String] = []
    ) {
        status = "watch_operation_failed"
        self.code = code
        self.gate = gate
        self.operatorAction = operatorAction
        self.safeToRetry = safeToRetry
        self.mustNotReregister = mustNotReregister
        self.detail = detail
        self.rejectedStatusCode = rejectedStatusCode
        self.rejectedCode = rejectedCode
        self.restartCursor = restartCursor
        self.operatorNotes = operatorNotes
    }

    public var description: String {
        "WatchGrantFailureDiagnosis(code: \(code.rawValue), gate: \(gate.rawValue), operatorAction: \(operatorAction.rawValue))"
    }

    public var debugDescription: String { description }

    public var customMirror: Mirror {
        Mirror(
            self,
            children: [
                "status": status,
                "code": code.rawValue,
                "gate": gate.rawValue,
                "operatorAction": operatorAction.rawValue,
                "safeToRetry": safeToRetry,
                "mustNotReregister": mustNotReregister,
                "detail": detail,
            ],
            displayStyle: .struct
        )
    }

    public static let keychainSigningNotes: [String] = [
        "Ad-hoc helpers cannot embed Keychain access groups; Developer ID signing is out of scope for Triangle releases.",
        "For LaunchAgent custody, use file custody: a public ad-hoc install enables credentials/local (0600 files), then rebind the profile.",
        "If the login Keychain is locked, unlock it once and retry.",
    ]

    public static let interactiveExclusionNotes: [String] = [
        "mcp-interactive profiles may be watch grant members for App Server notify-only wakes.",
        "grok-bot profiles may be watch grant members for native Grok Bot webhook wakes.",
        "Watch grant actors must stay event-driven or grok-bot; mcp-interactive cannot act as the grant actor.",
    ]

    public static func from(_ error: WatchGrantServiceError) -> WatchGrantFailureDiagnosis {
        switch error {
        case .keychainUnavailable:
            return WatchGrantFailureDiagnosis(
                code: .keychainUnavailable,
                gate: .keychain,
                operatorAction: .unlockLoginKeychain,
                safeToRetry: true,
                detail: "Watch grant Keychain storage is unavailable.",
                operatorNotes: keychainSigningNotes
            )
        case .helperUnavailable:
            return WatchGrantFailureDiagnosis(
                code: .helperUnavailable,
                gate: .network,
                operatorAction: .retryNetwork,
                safeToRetry: true,
                detail: "MESH watch transport or origin is unavailable.",
                operatorNotes: ["Confirm HTTPS origin reachability and helper network access."]
            )
        case .noEventDrivenMembers:
            return WatchGrantFailureDiagnosis(
                code: .noEventDrivenMembers,
                gate: .membership,
                operatorAction: .reviewWatchMembership,
                safeToRetry: false,
                detail: "No notify-eligible profiles are available for a watch grant.",
                operatorNotes: interactiveExclusionNotes
            )
        case .actorNotDeclared:
            return WatchGrantFailureDiagnosis(
                code: .actorNotDeclared,
                gate: .membership,
                operatorAction: .reviewWatchMembership,
                safeToRetry: false,
                detail: "Actor profile is not declared in the watch grant membership."
            )
        case .cursorAcpActorExcluded:
            return WatchGrantFailureDiagnosis(
                code: .actorNotDeclared,
                gate: .membership,
                operatorAction: .reviewWatchMembership,
                safeToRetry: false,
                detail: "cursor-acp profiles are watch members and cannot act as watch grant actors.",
                operatorNotes: [
                    "Keep an event-driven or headless Codex profile as the watch grant actor.",
                    "Cursor ACP joins the grant only through the shadow runtime binding.",
                ]
            )
        case .interactiveDeliveryExcluded:
            return WatchGrantFailureDiagnosis(
                code: .interactiveDeliveryExcluded,
                gate: .membership,
                operatorAction: .useEventDrivenProfile,
                safeToRetry: false,
                detail: "mcp-interactive profiles cannot act as watch grant actors.",
                operatorNotes: interactiveExclusionNotes
            )
        case .workloadAuthUnavailable:
            return WatchGrantFailureDiagnosis(
                code: .workloadAuthUnavailable,
                gate: .workloadAuth,
                operatorAction: .repairWorkloadAuth,
                safeToRetry: true,
                detail: "Workload authentication is unavailable for watch grant operations.",
                operatorNotes: [
                    "Confirm every member profile is bound (profiles-v1) to a triangle workload-key.json on the same origin as the actor.",
                    "Workload mint/DPoP failures are fail-closed; rebind or repair the workload key file without printing secrets.",
                ] + keychainSigningNotes
            )
        case .workloadKeyMissing:
            return WatchGrantFailureDiagnosis(
                code: .workloadKeyMissing,
                gate: .workloadAuth,
                operatorAction: .repairWorkloadAuth,
                safeToRetry: false,
                detail: "Workload key material is missing for a watch grant member profile.",
                operatorNotes: [
                    "Bind the profile to the agent's workload key file (`triangle-mailbox bind`).",
                    "Do not place mailbox or watch credentials in Node env or plists.",
                ]
            )
        case .credentialMissing:
            return WatchGrantFailureDiagnosis(
                code: .credentialMissing,
                gate: .keychain,
                operatorAction: .ensureWatchGrant,
                safeToRetry: false,
                detail: "Watch grant credential is not installed for this installation id."
            )
        case .invalidCursor:
            return WatchGrantFailureDiagnosis(
                code: .invalidCursor,
                gate: .validation,
                operatorAction: .none,
                safeToRetry: false,
                mustNotReregister: true,
                detail: "Watch cursor is invalid."
            )
        case .rejected(let statusCode, let code):
            let sanitized = sanitizeRejectedCode(code)
            let staleLocalCredential =
                sanitized == "replacement_unauthorized" || sanitized == "watch_credential_invalid"
            return WatchGrantFailureDiagnosis(
                code: .rejected,
                gate: .network,
                operatorAction: staleLocalCredential ? .replaceWatchGrant : .retryNetwork,
                safeToRetry: staleLocalCredential ? false : (statusCode >= 500 || statusCode == 429),
                detail: staleLocalCredential
                    ? "MESH rejected the local watch credential; re-run watch-ensure so the helper can recreate without replacement."
                    : "MESH rejected the watch grant request.",
                rejectedStatusCode: statusCode,
                rejectedCode: sanitized,
                operatorNotes: staleLocalCredential
                    ? [
                        "Current helpers keep the local binding until recreate succeeds, then replace it.",
                        "If ensure still fails on an older helper, move aside credentials/local/watch/<installation>.json (or the mailbox-watch Keychain item) and re-run watch-ensure.",
                    ]
                    : []
            )
        case .resyncRequired(let restartCursor):
            return WatchGrantFailureDiagnosis(
                code: .resyncRequired,
                gate: .network,
                operatorAction: .resyncWatchCursor,
                safeToRetry: true,
                detail: "Watch cursor requires resync.",
                restartCursor: restartCursor
            )
        case .invalidResponse:
            return WatchGrantFailureDiagnosis(
                code: .invalidResponse,
                gate: .network,
                operatorAction: .retryNetwork,
                safeToRetry: true,
                detail: "MESH returned an invalid watch grant response."
            )
        }
    }

    public static func from(_ error: VerifiedCredentialGateError) -> WatchGrantFailureDiagnosis {
        switch error {
        case .profileNotFound:
            return WatchGrantFailureDiagnosis(
                code: .profileNotFound,
                gate: .profile,
                operatorAction: .bindOrVerifyProfile,
                safeToRetry: false,
                detail: "Actor or member profile credential was not found."
            )
        case .credentialInvalid:
            return WatchGrantFailureDiagnosis(
                code: .credentialInvalid,
                gate: .profile,
                operatorAction: .bindOrVerifyProfile,
                safeToRetry: false,
                detail: "The bound workload key file or agent record is missing, unsafe, or malformed."
            )
        case .credentialRefused:
            return WatchGrantFailureDiagnosis(
                code: .credentialRefused,
                gate: .workloadAuth,
                operatorAction: .bindOrVerifyProfile,
                safeToRetry: false,
                detail: "MESH refused this agent's workload key."
            )
        case .agentPaused:
            return WatchGrantFailureDiagnosis(
                code: .agentPaused,
                gate: .profile,
                operatorAction: .resumeAgent,
                safeToRetry: false,
                detail: "The agent is paused; the owner must resume it."
            )
        case .offline:
            return WatchGrantFailureDiagnosis(
                code: .offline,
                gate: .network,
                operatorAction: .retryNetwork,
                safeToRetry: true,
                detail: "Profile verification could not reach MESH."
            )
        case .identityMismatch:
            return WatchGrantFailureDiagnosis(
                code: .identityMismatch,
                gate: .profile,
                operatorAction: .bindOrVerifyProfile,
                safeToRetry: false,
                detail: "Stored profile identity does not match MESH."
            )
        case .verificationFailed:
            return WatchGrantFailureDiagnosis(
                code: .verificationFailed,
                gate: .profile,
                operatorAction: .bindOrVerifyProfile,
                safeToRetry: true,
                detail: "Profile credential verification failed."
            )
        }
    }

    public static func from(_ error: ClientInstanceStoreError) -> WatchGrantFailureDiagnosis {
        switch error {
        case .notFound:
            return WatchGrantFailureDiagnosis(
                code: .actorNotDeclared,
                gate: .membership,
                operatorAction: .reviewWatchMembership,
                safeToRetry: false,
                detail: "Client instance for a watch member profile was not found."
            )
        case .unsafeStorage, .invalidRecord, .duplicateProfile:
            return WatchGrantFailureDiagnosis(
                code: .instanceStoreUnavailable,
                gate: .membership,
                operatorAction: .reviewWatchMembership,
                safeToRetry: false,
                detail: "Client instance store is unavailable or invalid for watch membership."
            )
        }
    }

    public static func from(_ error: Error) -> WatchGrantFailureDiagnosis {
        if let error = error as? WatchGrantServiceError {
            return from(error)
        }
        if let error = error as? VerifiedCredentialGateError {
            return from(error)
        }
        if let error = error as? ClientInstanceStoreError {
            return from(error)
        }
        return WatchGrantFailureDiagnosis(
            code: .operationFailed,
            gate: .validation,
            operatorAction: .none,
            safeToRetry: false,
            detail: "Watch operation failed without a classified gate.",
            operatorNotes: ["Re-run with a current helper from scripts/install-macos-mailbox-helper.sh."]
        )
    }

    private static func sanitizeRejectedCode(_ code: String) -> String {
        let trimmed = code.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.wholeMatch(of: /^[a-z][a-z0-9_]{0,63}$/) != nil else {
            return "watch_rejected"
        }
        // Never echo anything that looks like a credential prefix.
        if trimmed.contains("mesh_") { return "watch_rejected" }
        return trimmed
    }
}

public enum WatchGrantFailureRenderer {
    public static func render(_ diagnosis: WatchGrantFailureDiagnosis) throws -> RenderedCLIOutput {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        var stderr = try encoder.encode(diagnosis)
        stderr.append(0x0a)
        let text = String(decoding: stderr, as: UTF8.self)
        if text.contains("mesh_watch_") || text.contains("mesh_watch_stage_") || text.contains("\"mesh_") {
            return RenderedCLIOutput(
                stdout: Data(),
                stderr: Data("{\"status\":\"watch_operation_failed\",\"code\":\"operation_failed\",\"gate\":\"validation\",\"operatorAction\":\"none\",\"safeToRetry\":false,\"mustNotReregister\":true,\"detail\":\"Watch failure diagnosis failed closed.\"}\n".utf8),
                exitCode: 1
            )
        }
        return RenderedCLIOutput(stdout: Data(), stderr: stderr, exitCode: 1)
    }
}

/// Secret-free help payload proving a watch verb is present in this helper binary.
public struct WatchCommandHelp: Codable, Equatable, Sendable {
    public let command: String
    public let supported: Bool
    public let requires: [String]
    public let phase: String
    public let notes: [String]

    public init(command: HelperCommand) {
        self.command = command.rawValue
        supported = true
        phase = "watch-grant-phase-2"
        switch command {
        case .watchEnsure:
            requires = ["--installation", "--actor-profile"]
            notes = [
                "Creates/joins/finalizes an installation-scoped watch grant for notify members.",
                "Optional repeatable --member-profile selects an explicit notify set (must include the actor); omit for auto membership.",
                "Bound headless Codex, mcp-interactive, and grok-bot profiles may be notify members; mcp-interactive cannot act as the grant actor; Cursor ACP is excluded until a kick path exists.",
                "Failures emit secret-free JSON on stderr with code, gate, and operatorAction.",
            ]
        case .watchStatus:
            requires = ["--installation"]
            notes = ["Secret-free status JSON only; never prints watch credential material."]
        case .watchRevoke:
            requires = ["--installation"]
            notes = ["Revokes remotely and deletes the local mailbox-watch Keychain item."]
        case .watchPoll:
            requires = ["--installation", "--cursor"]
            notes = ["Held poll for Node wake clients; credentials stay in the helper Keychain."]
        case .bind, .unbind, .status, .mcp, .runWorker, .runSupervisor, .preflightSupervisor,
             .transactionPreflight, .transactionStatus, .transactionClaim, .transactionClaimNext, .transactionDrainReceipts, .transactionReply,
             .transactionReadInbound, .transactionAck, .transactionAbandon, .transactionRecordFailure:
            requires = []
            notes = []
        }
    }
}

public enum WatchCommandHelpRenderer {
    public static func render(_ help: WatchCommandHelp) throws -> RenderedCLIOutput {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        var stdout = try encoder.encode(help)
        stdout.append(0x0a)
        return RenderedCLIOutput(stdout: stdout, stderr: Data(), exitCode: 0)
    }
}
