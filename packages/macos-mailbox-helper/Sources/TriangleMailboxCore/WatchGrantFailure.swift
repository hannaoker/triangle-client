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
    case localAuthorizationRequired = "local_authorization_required"
    case offline = "offline"
    case identityMismatch = "identity_mismatch"
    case verificationFailed = "verification_failed"
    case journalIneligible = "journal_ineligible"
    case credentialBusy = "credential_busy"
    case profileStateInconsistent = "profile_state_inconsistent"
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
        "Ad-hoc (--local-ad-hoc) helpers cannot embed Developer ID Keychain access groups.",
        "For LaunchAgent custody, reinstall with TRIANGLE_DEVELOPER_ID / TRIANGLE_DEVELOPER_TEAM_ID.",
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
                    "Confirm Keychain item dev.thetriangle.mesh.workload-key exists for the actor profile.",
                    "Workload mint/DPoP failures are fail-closed; re-enroll or repair workload material without printing secrets.",
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
                    "Re-enroll the profile so workload-key Keychain material is installed.",
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
                operatorAction: .enrollOrVerifyProfile,
                safeToRetry: false,
                detail: "Actor or member profile credential was not found."
            )
        case .localAuthorizationRequired:
            return WatchGrantFailureDiagnosis(
                code: .localAuthorizationRequired,
                gate: .keychain,
                operatorAction: .unlockLoginKeychain,
                safeToRetry: true,
                detail: "Login Keychain authorization is required before watch ensure can proceed.",
                operatorNotes: keychainSigningNotes
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
                operatorAction: .enrollOrVerifyProfile,
                safeToRetry: false,
                detail: "Stored profile identity does not match MESH."
            )
        case .verificationFailed:
            return WatchGrantFailureDiagnosis(
                code: .verificationFailed,
                gate: .profile,
                operatorAction: .enrollOrVerifyProfile,
                safeToRetry: true,
                detail: "Profile credential verification failed."
            )
        case .journalIneligible:
            return WatchGrantFailureDiagnosis(
                code: .journalIneligible,
                gate: .profile,
                operatorAction: .enrollOrVerifyProfile,
                safeToRetry: false,
                detail: "Enrollment journal state is ineligible for watch grant operations."
            )
        case .credentialBusy:
            return WatchGrantFailureDiagnosis(
                code: .credentialBusy,
                gate: .profile,
                operatorAction: .retryLater,
                safeToRetry: true,
                mustNotReregister: true,
                detail: "Enrollment reservation is busy (enroll-*.lock contention); retry without reminting or reregistering.",
                operatorNotes: [
                    "Another triangle-mailbox process (watch-ensure, status, or transaction-*) holds the profile enrollment lock.",
                    "Do not move aside watch JSON or re-enroll; wait briefly and retry the same command.",
                ]
            )
        case .profileStateInconsistent:
            return WatchGrantFailureDiagnosis(
                code: .profileStateInconsistent,
                gate: .profile,
                operatorAction: .enrollOrVerifyProfile,
                safeToRetry: false,
                detail: "Profile Keychain and journal state are inconsistent."
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
                "mcp-interactive and grok-bot profiles may be notify members (App Server / Grok Bot wake); mcp-interactive cannot act as the grant actor.",
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
        case .enroll, .status, .mcp, .runWorker, .runSupervisor, .preflightSupervisor,
             .transactionPreflight, .transactionStatus, .transactionClaim, .transactionClaimNext, .transactionReply,
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
