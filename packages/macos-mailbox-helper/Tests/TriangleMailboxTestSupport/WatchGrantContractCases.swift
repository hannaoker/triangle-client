import Foundation
@_spi(EnrollmentTesting) import TriangleMailboxCore
@_spi(WatchGrantStoreTesting) import TriangleMailboxCore

#if canImport(Security)
import Security
#endif

public enum WatchGrantContractCases {
    public struct ContractCase: Sendable {
        public let name: String
        public let run: @Sendable () async throws -> Void
    }

    public static var all: [ContractCase] {
        var cases: [ContractCase] = [
            .init(name: "watch grant identifiers", run: identifiers),
            .init(name: "watch grant binding redacts secrets", run: bindingRedactsSecrets),
            .init(name: "watch grant store create/read/replace/delete", run: storeLifecycle),
            .init(name: "watch grant store errors redact secrets", run: secretFreeErrors),
            .init(name: "watch command parser", run: commandParser),
            .init(name: "watch command help surface", run: commandHelpSurface),
            .init(name: "watch grant ensure join finalize stores credential", run: ensureLifecycle),
            .init(name: "watch grant status is secret-free", run: statusSecretFree),
            .init(name: "watch grant poll and resync mapping", run: pollAndResync),
            .init(name: "watch grant revoke clears local binding", run: revokeClearsBinding),
            .init(name: "watch grant excludes mcp-interactive actors", run: excludesInteractiveActor),
            .init(name: "watch grant allows mcp-interactive notify members", run: includesInteractiveMember),
            .init(name: "watch grant fails closed without keychain", run: failsClosedWithoutStore),
            .init(name: "watch grant failure diagnosis is structured and secret-free", run: failureDiagnosis),
            .init(name: "watch grant recovers from stale replacement credential", run: recoversFromStaleReplacement),
            .init(name: "watch grant does not discard local binding on unrelated create rejection", run: unrelatedCreateRejectionKeepsLocalBinding),
        ]
#if canImport(Security)
        cases.append(.init(name: "watch grant Keychain query policy", run: keychainQueryPolicy))
#endif
        return cases
    }

    public static func identifiers() throws {
        try expect(try InstallationID("inst_N7VhDq3mQ2").value == "inst_N7VhDq3mQ2", "valid installation rejected")
        try expectThrows(WatchGrantValidationError.self, "short installation accepted") {
            try InstallationID("inst_short")
        }
        let grant = try WatchGrantID("watchgrant_" + String(repeating: "a", count: 64))
        try expect(grant.value.hasPrefix("watchgrant_"), "grant id rejected")
        let staging = try WatchStagingCredential("mesh_watch_stage_" + String(repeating: "b", count: 64))
        let watch = try WatchCredential("mesh_watch_" + String(repeating: "c", count: 64))
        try expect(!String(describing: staging).contains("mesh_watch_stage_"), "staging credential leaked")
        try expect(!String(describing: watch).contains("mesh_watch_"), "watch credential leaked")
    }

    public static func bindingRedactsSecrets() throws {
        let canary = "mesh_watch_" + String(repeating: "d", count: 64)
        let binding = try WatchGrantBinding(
            installationID: InstallationID("inst_N7VhDq3mQ2"),
            origin: MeshOrigin("https://thetriangle.dev"),
            grantID: WatchGrantID("watchgrant_" + String(repeating: "e", count: 64)),
            agentIDs: [AgentID("agent_" + String(repeating: "a", count: 32))],
            watchCredential: WatchCredential(canary)
        )
        for output in [String(describing: binding), String(reflecting: binding)] {
            try expect(!output.contains(canary), "binding diagnostic exposed watch credential")
            try expect(output.contains("<redacted>"), "binding diagnostic omitted redaction marker")
        }
    }

    public static func storeLifecycle() throws {
        let store = InMemoryWatchGrantStore()
        let first = try binding(digit: "a")
        let second = try binding(digit: "b")
        try store.create(first)
        try expectStoreError(.duplicateItem, "duplicate create succeeded") {
            try store.create(second)
        }
        try expect(try store.read(for: first.installationID) == first, "read mismatch")
        try expectStoreError(.replacementNotConfirmed, "unconfirmed replace succeeded") {
            try store.replace(second, confirmation: .notConfirmed)
        }
        try store.replace(second, confirmation: .confirmed)
        try expect(try store.read(for: first.installationID) == second, "replace did not persist")
        try store.delete(for: first.installationID)
        try expectStoreError(.itemNotFound, "deleted grant remained readable") {
            try store.read(for: first.installationID)
        }
    }

    public static func secretFreeErrors() throws {
        let canary = "mesh_watch_" + String(repeating: "f", count: 64)
        for error in WatchGrantStoreError.allBoundedCases {
            let text = String(describing: error) + String(reflecting: error)
            try expect(!text.contains(canary), "store error exposed secret")
        }
        for error: WatchGrantServiceError in [
            .keychainUnavailable, .helperUnavailable, .noEventDrivenMembers, .actorNotDeclared,
            .interactiveDeliveryExcluded, .workloadAuthUnavailable, .workloadKeyMissing, .credentialMissing, .invalidCursor,
            .rejected(statusCode: 401, code: "watch_credential_invalid"), .resyncRequired(restartCursor: 9),
            .invalidResponse,
        ] {
            let text = String(describing: error) + String(reflecting: error)
            try expect(!text.contains(canary), "service error exposed secret")
            try expect(!text.contains("mesh_"), "service error exposed mesh_ prefix")
        }
    }

    public static func commandHelpSurface() throws {
        for command in [HelperCommand.watchEnsure, .watchPoll, .watchStatus, .watchRevoke] {
            do {
                _ = try CommandParser.parse([command.rawValue, "--help"])
                throw ContractFailure("\(command.rawValue) --help did not request help")
            } catch CommandParseError.helpRequested(let requested) {
                try expect(requested == command, "\(command.rawValue) help mapped to wrong command")
            }
            let rendered = try WatchCommandHelpRenderer.render(WatchCommandHelp(command: command))
            try expect(rendered.exitCode == 0, "\(command.rawValue) help exit mismatch")
            let text = String(decoding: rendered.stdout, as: UTF8.self)
            try expect(text.contains("\"supported\":true"), "\(command.rawValue) help missing supported")
            try expect(text.contains("\"command\":\"\(command.rawValue)\""), "\(command.rawValue) help missing command")
            try expect(text.contains("watch-grant-phase-2"), "\(command.rawValue) help missing phase")
            try expect(!text.contains("mesh_"), "\(command.rawValue) help exposed secret prefix")
        }
    }

    public static func failureDiagnosis() throws {
        let canary = "mesh_watch_" + String(repeating: "f", count: 64)
        let cases: [(WatchGrantServiceError, WatchGrantFailureGate, WatchGrantFailureCode, WatchGrantOperatorAction)] = [
            (.keychainUnavailable, .keychain, .keychainUnavailable, .unlockLoginKeychain),
            (.interactiveDeliveryExcluded, .membership, .interactiveDeliveryExcluded, .useEventDrivenProfile),
            (.workloadKeyMissing, .workloadAuth, .workloadKeyMissing, .repairWorkloadAuth),
            (.workloadAuthUnavailable, .workloadAuth, .workloadAuthUnavailable, .repairWorkloadAuth),
            (.noEventDrivenMembers, .membership, .noEventDrivenMembers, .reviewWatchMembership),
            (.helperUnavailable, .network, .helperUnavailable, .retryNetwork),
            (.rejected(statusCode: 403, code: "watch_forbidden"), .network, .rejected, .retryNetwork),
            (.rejected(statusCode: 401, code: "replacement_unauthorized"), .network, .rejected, .replaceWatchGrant),
            (.rejected(statusCode: 401, code: "watch_credential_invalid"), .network, .rejected, .replaceWatchGrant),
            (.credentialMissing, .keychain, .credentialMissing, .ensureWatchGrant),
        ]
        for (error, gate, code, action) in cases {
            let diagnosis = WatchGrantFailureDiagnosis.from(error)
            try expect(diagnosis.gate == gate, "\(code.rawValue) gate mismatch")
            try expect(diagnosis.code == code, "\(code.rawValue) code mismatch")
            try expect(diagnosis.operatorAction == action, "\(code.rawValue) action mismatch")
            try expect(diagnosis.status == "watch_operation_failed", "\(code.rawValue) status mismatch")
            let rendered = try WatchGrantFailureRenderer.render(diagnosis)
            try expect(rendered.exitCode == 1, "\(code.rawValue) should fail closed")
            let text = String(decoding: rendered.stderr, as: UTF8.self)
            try expect(text.contains("\"gate\":\"\(gate.rawValue)\""), "\(code.rawValue) stderr missing gate")
            try expect(text.contains("\"code\":\"\(code.rawValue)\""), "\(code.rawValue) stderr missing code")
            try expect(text.contains("\"operatorAction\":"), "\(code.rawValue) stderr missing operatorAction")
            try expect(!text.contains(canary), "\(code.rawValue) stderr exposed canary")
            try expect(!text.contains("mesh_watch_"), "\(code.rawValue) stderr exposed watch credential prefix")
            try expect(!String(describing: diagnosis).contains(canary), "\(code.rawValue) description exposed canary")
        }

        let interactive = WatchGrantFailureDiagnosis.from(WatchGrantServiceError.interactiveDeliveryExcluded)
        try expect(
            interactive.operatorNotes.contains(where: { $0.contains("mcp-interactive") }),
            "interactive exclusion omitted mcp-interactive note"
        )
        let keychain = WatchGrantFailureDiagnosis.from(WatchGrantServiceError.keychainUnavailable)
        try expect(
            keychain.operatorNotes.contains(where: { $0.contains("Developer ID") }),
            "keychain failure omitted Developer ID note"
        )

        let profile = WatchGrantFailureDiagnosis.from(VerifiedCredentialGateError.localAuthorizationRequired)
        try expect(profile.gate == .keychain, "credential gate lock should map to keychain")
        try expect(profile.operatorAction == .unlockLoginKeychain, "credential gate lock action mismatch")

        let poisoned = WatchGrantFailureDiagnosis.from(
            WatchGrantServiceError.rejected(statusCode: 401, code: "mesh_watch_leak_attempt")
        )
        try expect(poisoned.rejectedCode == "watch_rejected", "rejected code sanitizer allowed mesh_ prefix")
    }

    public static func commandParser() throws {
        let ensure = try CommandParser.parse([
            "watch-ensure", "--installation", "inst_N7VhDq3mQ2", "--actor-profile", "codex-mailbox-live",
        ])
        try expect(ensure.command == .watchEnsure, "watch-ensure rejected")
        try expect(ensure.installationID?.value == "inst_N7VhDq3mQ2", "installation not parsed")
        try expect(ensure.profile?.value == "codex-mailbox-live", "actor profile not parsed")

        let status = try CommandParser.parse(["watch-status", "--installation", "inst_N7VhDq3mQ2"])
        try expect(status.command == .watchStatus, "watch-status rejected")
        let revoke = try CommandParser.parse(["watch-revoke", "--installation", "inst_N7VhDq3mQ2"])
        try expect(revoke.command == .watchRevoke, "watch-revoke rejected")
        let poll = try CommandParser.parse(["watch-poll", "--installation", "inst_N7VhDq3mQ2", "--cursor", "12"])
        try expect(poll.command == .watchPoll && poll.cursor == 12, "watch-poll rejected")

        for invalid in [
            ["watch-poll", "--installation", "inst_N7VhDq3mQ2", "--cursor", "-1"],
            ["watch-ensure", "--installation", "inst_N7VhDq3mQ2"],
            ["watch-status", "--installation", "inst_N7VhDq3mQ2", "--token", "secret"],
            ["watch-revoke", "--installation", "bad"],
        ] {
            try expectThrows(CommandParseError.self, "watch parser accepted invalid input") {
                try CommandParser.parse(invalid)
            }
        }
    }

    public static func ensureLifecycle() async throws {
        let fixture = try await Fixture()
        let status = try await fixture.service.ensureGrant(
            installationID: fixture.installationID,
            actorProfile: fixture.actorProfile,
            memberProfiles: [fixture.actorProfile, fixture.memberProfile]
        )
        try expect(status.state == "finalized", "ensure did not finalize")
        try expect(status.grantID != nil, "grant id missing from status")
        try expect(!String(describing: status).contains("mesh_watch_"), "status exposed watch credential")
        let stored = try fixture.store.read(for: fixture.installationID)
        try expect(stored.agentIDs.count == 2, "membership not stored")
        try expect(fixture.transport.paths.contains("/api/v1/mailbox/watch/grants"), "create was not called")
        try expect(fixture.transport.paths.contains { $0.hasSuffix("/join") }, "join was not called")
        try expect(fixture.transport.paths.contains { $0.hasSuffix("/finalize") }, "finalize was not called")
        try expect(!fixture.transport.loggedBodies.contains { $0.contains("mesh_watch_") }, "transport log exposed secrets")
    }

    public static func statusSecretFree() async throws {
        let fixture = try await Fixture()
        _ = try await fixture.service.ensureGrant(
            installationID: fixture.installationID,
            actorProfile: fixture.actorProfile,
            memberProfiles: [fixture.actorProfile]
        )
        let status = try fixture.service.status(installationID: fixture.installationID)
        let rendered = try WatchGrantOperatorStatusRenderer.render(status)
        let text = String(decoding: rendered.stdout, as: UTF8.self)
        try expect(!text.contains("mesh_"), "rendered status exposed secret")
        try expect(text.contains("\"state\":\"finalized\""), "rendered status missing state")
        try expect(text.contains("\"operatorAction\":\"none\""), "rendered status missing operatorAction")
        try expect(text.contains("\"listenerReady\":true"), "rendered status missing listenerReady")
        try expect(text.contains("\"memberCount\":"), "rendered status missing memberCount")
        try expect(status.operatorAction == .none, "finalized grant should need no operator action")
        try expect(status.listenerReady, "finalized grant should be listener-ready")
        try expect(status.memberCount == status.agentIDs.count, "memberCount should match agent ids")

        let missing = try fixture.service.status(installationID: try InstallationID("inst_MissingGrant01"))
        try expect(missing.state == "missing", "missing grant state mismatch")
        try expect(missing.operatorAction == .ensureWatchGrant, "missing grant should ask ensure")
        try expect(!missing.listenerReady, "missing grant must not be listener-ready")
    }

    public static func pollAndResync() async throws {
        let fixture = try await Fixture()
        _ = try await fixture.service.ensureGrant(
            installationID: fixture.installationID,
            actorProfile: fixture.actorProfile,
            memberProfiles: [fixture.actorProfile]
        )
        fixture.transport.nextPoll = .success(WatchPollResponse(
            cursor: 4,
            events: [WatchPollEvent(agentID: fixture.actorAgentID.value, highWatermark: 4)]
        ))
        let polled = try await fixture.service.poll(installationID: fixture.installationID, cursor: 0)
        try expect(polled.cursor == 4 && polled.events.count == 1, "poll response mismatch")

        fixture.transport.nextPoll = .resync(7)
        do {
            _ = try await fixture.service.poll(installationID: fixture.installationID, cursor: 1)
            throw ContractFailure("resync poll succeeded")
        } catch WatchGrantServiceError.resyncRequired(let restart) {
            try expect(restart == 7, "resync restart cursor mismatch")
        }
    }

    public static func revokeClearsBinding() async throws {
        let fixture = try await Fixture()
        _ = try await fixture.service.ensureGrant(
            installationID: fixture.installationID,
            actorProfile: fixture.actorProfile,
            memberProfiles: [fixture.actorProfile]
        )
        let revoked = try await fixture.service.revoke(installationID: fixture.installationID)
        try expect(revoked.state == "revoked", "revoke status mismatch")
        try expectStoreError(.itemNotFound, "revoked binding remained") {
            try fixture.store.read(for: fixture.installationID)
        }
    }

    public static func excludesInteractiveActor() async throws {
        let fixture = try await Fixture()
        try fixture.instances.setDeliveryMode(.mcpInteractive, profile: fixture.actorProfile)
        do {
            _ = try await fixture.service.ensureGrant(
                installationID: fixture.installationID,
                actorProfile: fixture.actorProfile
            )
            throw ContractFailure("mcp-interactive actor was accepted")
        } catch WatchGrantServiceError.interactiveDeliveryExcluded {
            return
        }
    }

    public static func includesInteractiveMember() async throws {
        let fixture = try await Fixture()
        try fixture.instances.setDeliveryMode(.mcpInteractive, profile: fixture.memberProfile)
        let status = try await fixture.service.ensureGrant(
            installationID: fixture.installationID,
            actorProfile: fixture.actorProfile,
            memberProfiles: [fixture.actorProfile, fixture.memberProfile]
        )
        try expect(status.state == "finalized", "interactive member grant was not finalized")
        try expect(
            status.agentIDs.contains(fixture.memberAgentID.value),
            "mcp-interactive notify member missing from grant"
        )
        try expect(
            status.agentIDs.contains(fixture.actorAgentID.value),
            "event-driven actor missing from grant"
        )
    }

    public static func failsClosedWithoutStore() async throws {
        let fixture = try await Fixture(failingStore: true)
        do {
            _ = try await fixture.service.ensureGrant(
                installationID: fixture.installationID,
                actorProfile: fixture.actorProfile,
                memberProfiles: [fixture.actorProfile]
            )
            throw ContractFailure("unavailable store succeeded")
        } catch WatchGrantServiceError.keychainUnavailable {
            return
        }
    }

    public static func recoversFromStaleReplacement() async throws {
        for rejectedCode in ["replacement_unauthorized", "watch_credential_invalid"] {
            let fixture = try await Fixture()
            let stale = try WatchGrantBinding(
                installationID: fixture.installationID,
                origin: MeshOrigin("https://thetriangle.dev"),
                grantID: WatchGrantID("watchgrant_" + String(repeating: "9", count: 64)),
                agentIDs: [fixture.actorAgentID],
                watchCredential: WatchCredential("mesh_watch_" + String(repeating: "9", count: 64))
            )
            try fixture.store.create(stale)
            fixture.transport.rejectCreateWithReplacementOnce = (401, rejectedCode)

            let status = try await fixture.service.ensureGrant(
                installationID: fixture.installationID,
                actorProfile: fixture.actorProfile,
                memberProfiles: [fixture.actorProfile]
            )
            try expect(status.state == "finalized", "\(rejectedCode): ensure did not recover")
            try expect(fixture.transport.createCallCount == 2, "\(rejectedCode): expected discard+retry create")
            try expect(
                fixture.transport.createReplacementHeaderFlags == [true, false],
                "\(rejectedCode): second create must omit replacement header"
            )
            let stored = try fixture.store.read(for: fixture.installationID)
            try expect(stored != stale, "\(rejectedCode): stale local credential was not replaced")
            try expect(stored.grantID.value == "watchgrant_" + String(repeating: "3", count: 64), "\(rejectedCode): unexpected recovered grant id")
            try expect(!String(describing: status).contains("mesh_watch_"), "\(rejectedCode): status exposed secret")
        }
    }

    public static func unrelatedCreateRejectionKeepsLocalBinding() async throws {
        let fixture = try await Fixture()
        let existing = try WatchGrantBinding(
            installationID: fixture.installationID,
            origin: MeshOrigin("https://thetriangle.dev"),
            grantID: WatchGrantID("watchgrant_" + String(repeating: "8", count: 64)),
            agentIDs: [fixture.actorAgentID],
            watchCredential: WatchCredential("mesh_watch_" + String(repeating: "8", count: 64))
        )
        try fixture.store.create(existing)
        fixture.transport.rejectCreateWithReplacementOnce = (403, "watch_forbidden")

        do {
            _ = try await fixture.service.ensureGrant(
                installationID: fixture.installationID,
                actorProfile: fixture.actorProfile,
                memberProfiles: [fixture.actorProfile]
            )
            throw ContractFailure("unrelated create rejection succeeded")
        } catch WatchGrantServiceError.rejected(let statusCode, let code) {
            try expect(statusCode == 403 && code == "watch_forbidden", "unexpected rejection mapping")
        }
        try expect(fixture.transport.createCallCount == 1, "unrelated rejection should not retry create")
        let stored = try fixture.store.read(for: fixture.installationID)
        try expect(stored == existing, "unrelated rejection deleted local binding")
    }

#if canImport(Security)
    public static func keychainQueryPolicy() throws {
        let installation = try InstallationID("inst_N7VhDq3mQ2")
        let encoded = Data("disposable-watch-binding".utf8)
        let queries: [(String, [CFString: Any])] = [
            ("add", WatchGrantKeychainQueryBuilder.addQuery(for: installation, encodedBinding: encoded)),
            ("copy", WatchGrantKeychainQueryBuilder.copyQuery(for: installation)),
            ("update", WatchGrantKeychainQueryBuilder.updateQuery(for: installation)),
            ("delete", WatchGrantKeychainQueryBuilder.deleteQuery(for: installation)),
        ]
        for (operation, query) in queries {
            try expect(query[kSecAttrService] as? String == "dev.thetriangle.mesh.mailbox-watch", "\(operation) changed watch service")
            try expect(query[kSecAttrAccount] as? String == installation.value, "\(operation) changed account")
            try expect(query[kSecUseDataProtectionKeychain] as? Bool == true, "\(operation) omitted Data Protection Keychain")
            try expect(query[kSecAttrSynchronizable] as? Bool == false, "\(operation) allowed sync")
            try expect(query[kSecAttrAccessGroup] == nil, "\(operation) accepted access group")
        }
    }
#endif

    private final class Fixture: @unchecked Sendable {
        let installationID: InstallationID
        let actorProfile: ProfileName
        let memberProfile: ProfileName
        let actorAgentID: AgentID
        let memberAgentID: AgentID
        let store: any WatchGrantStore
        let transport: ScriptedWatchTransport
        let instances: InMemoryClientInstanceStore
        let service: WatchGrantService

        init(failingStore: Bool = false) async throws {
            installationID = try InstallationID("inst_N7VhDq3mQ2")
            actorProfile = try ProfileName("codex-mailbox-live")
            memberProfile = try ProfileName("hermes-mailbox-live")
            actorAgentID = try AgentID("agent_" + String(repeating: "a", count: 32))
            memberAgentID = try AgentID("agent_" + String(repeating: "b", count: 32))
            store = failingStore ? FailingWatchGrantStore() : InMemoryWatchGrantStore()
            transport = ScriptedWatchTransport(
                actorAgentID: actorAgentID,
                memberAgentID: memberAgentID,
                installationID: installationID
            )
            let credentials = InMemoryCredentialStore()
            try credentials.create(
                CredentialBinding(
                    origin: MeshOrigin("https://thetriangle.dev"),
                    agentID: actorAgentID,
                    handle: MailboxHandle("codex-mailbox-live"),
                    token: MeshToken("mesh_" + String(repeating: "a", count: 64))
                ),
                for: actorProfile
            )
            try credentials.create(
                CredentialBinding(
                    origin: MeshOrigin("https://thetriangle.dev"),
                    agentID: memberAgentID,
                    handle: MailboxHandle("hermes-mailbox-live"),
                    token: MeshToken("mesh_" + String(repeating: "b", count: 64))
                ),
                for: memberProfile
            )
            instances = InMemoryClientInstanceStore()
            try instances.create(ClientInstance(profile: actorProfile, runtimeAdapter: .codex, deliveryMode: .eventDriven))
            try instances.create(ClientInstance(profile: memberProfile, runtimeAdapter: .hermes, deliveryMode: .eventDriven))
            let journal = InMemoryEnrollmentJournal()
            try journal.write(.testing(
                profile: actorProfile,
                origin: MeshOrigin("https://thetriangle.dev"),
                state: .verified,
                agentID: actorAgentID,
                handle: MailboxHandle("codex-mailbox-live"),
                reasonCode: "identity_verified"
            ))
            try journal.write(.testing(
                profile: memberProfile,
                origin: MeshOrigin("https://thetriangle.dev"),
                state: .verified,
                agentID: memberAgentID,
                handle: MailboxHandle("hermes-mailbox-live"),
                reasonCode: "identity_verified"
            ))
            let gate = VerifiedCredentialGate(
                store: credentials,
                transport: transport,
                reservation: InMemoryEnrollmentReservation(),
                journal: journal
            )
            service = WatchGrantService(
                store: store,
                transport: transport,
                auth: StaticWatchGrantAuthProvider(),
                credentialGate: gate,
                instanceStore: instances
            )
        }
    }

    private static func binding(digit: Character) throws -> WatchGrantBinding {
        try WatchGrantBinding(
            installationID: InstallationID("inst_N7VhDq3mQ2"),
            origin: MeshOrigin("https://thetriangle.dev"),
            grantID: WatchGrantID("watchgrant_" + String(repeating: digit, count: 64)),
            agentIDs: [AgentID("agent_" + String(repeating: digit, count: 32))],
            watchCredential: WatchCredential("mesh_watch_" + String(repeating: digit, count: 64))
        )
    }

    private static func expect(_ condition: @autoclosure () throws -> Bool, _ message: String) throws {
        guard try condition() else { throw ContractFailure(message) }
    }

    private static func expectThrows<T: Error, Result>(
        _ type: T.Type,
        _ message: String,
        operation: () throws -> Result
    ) throws {
        do {
            _ = try operation()
            throw ContractFailure(message)
        } catch is T {
            return
        } catch {
            throw ContractFailure("\(message): wrong error type")
        }
    }

    private static func expectStoreError<Result>(
        _ expected: WatchGrantStoreError,
        _ message: String,
        operation: () throws -> Result
    ) throws {
        do {
            _ = try operation()
            throw ContractFailure(message)
        } catch let error as WatchGrantStoreError {
            guard error == expected else { throw ContractFailure("\(message): wrong store error") }
        } catch {
            throw ContractFailure("\(message): wrong error type")
        }
    }
}

private struct StaticWatchGrantAuthProvider: WatchGrantAuthProviding {
    func authorizationHeaders(for profile: ProfileName, method: String, url: URL) async throws -> [String: String] {
        [
            "Authorization": "Bearer workload-test-token",
            "DPoP": "dpop-test-proof",
        ]
    }
}

private final class FailingWatchGrantStore: WatchGrantStore, @unchecked Sendable {
    func create(_ binding: WatchGrantBinding) throws { throw WatchGrantStoreError.keychainFailure }
    func read(for installationID: InstallationID) throws -> WatchGrantBinding { throw WatchGrantStoreError.keychainFailure }
    func replace(_ binding: WatchGrantBinding, confirmation: CredentialReplacementConfirmation) throws {
        throw WatchGrantStoreError.keychainFailure
    }
    func delete(for installationID: InstallationID) throws { throw WatchGrantStoreError.keychainFailure }
}

private enum PollScript {
    case success(WatchPollResponse)
    case resync(Int)
}

private final class ScriptedWatchTransport: MeshTransport, @unchecked Sendable {
    private let lock = NSLock()
    private let actorAgentID: AgentID
    private let memberAgentID: AgentID
    private let installationID: InstallationID
    private(set) var paths: [String] = []
    private(set) var loggedBodies: [String] = []
    private(set) var createCallCount = 0
    private(set) var createReplacementHeaderFlags: [Bool] = []
    /// When set, the next create that includes Mesh-Watch-Credential returns this rejection once.
    var rejectCreateWithReplacementOnce: (statusCode: Int, code: String)?
    var nextPoll: PollScript = .success(WatchPollResponse(cursor: 0, events: []))
    private var stagedCredential = "mesh_watch_stage_" + String(repeating: "1", count: 64)
    private var watchCredential = "mesh_watch_" + String(repeating: "2", count: 64)
    private var grantID = "watchgrant_" + String(repeating: "3", count: 64)

    init(actorAgentID: AgentID, memberAgentID: AgentID, installationID: InstallationID) {
        self.actorAgentID = actorAgentID
        self.memberAgentID = memberAgentID
        self.installationID = installationID
    }

    func send(_ request: MeshHTTPRequest) async throws -> MeshHTTPResponse {
        try lock.withLock {
            paths.append(request.url.path)
            if let body = String(data: request.body, encoding: .utf8) {
                loggedBodies.append("<redacted:\(body.count)>")
            }
            let path = request.url.path
            if path == "/api/v1/mailbox/watch/grants" && request.method == "POST" {
                createCallCount += 1
                let hasReplacement = request.headers.keys.contains { $0.caseInsensitiveCompare("Mesh-Watch-Credential") == .orderedSame }
                createReplacementHeaderFlags.append(hasReplacement)
                if hasReplacement, let rejection = rejectCreateWithReplacementOnce {
                    rejectCreateWithReplacementOnce = nil
                    let body = Data("{\"error\":\"\(rejection.code)\"}".utf8)
                    return MeshHTTPResponse(
                        statusCode: rejection.statusCode,
                        headers: ["Content-Type": "application/json"],
                        body: body,
                        finalURL: request.url
                    )
                }
                let requested: [String]
                if let object = try? JSONSerialization.jsonObject(with: request.body) as? [String: Any],
                   let agentIDs = object["agent_ids"] as? [String]
                {
                    requested = agentIDs.sorted()
                } else {
                    requested = [actorAgentID.value, memberAgentID.value].sorted()
                }
                let body = Data("""
                {"grant_id":"\(grantID)","installation_id":"\(installationID.value)","agent_ids":\(jsonArray(requested)),"staging_credential":"\(stagedCredential)","expires_at":"2099-01-01T00:00:00.000Z","audience":"mesh-mailbox-watch","purpose":"notification-only"}
                """.utf8)
                return MeshHTTPResponse(statusCode: 201, headers: ["Content-Type": "application/json"], body: body, finalURL: request.url)
            }
            if path.hasSuffix("/join") {
                let body = Data("""
                {"grant_id":"\(grantID)","agent_id":"\(actorAgentID.value)","state":"proven"}
                """.utf8)
                return MeshHTTPResponse(statusCode: 200, headers: ["Content-Type": "application/json"], body: body, finalURL: request.url)
            }
            if path.hasSuffix("/finalize") {
                let body = Data("""
                {"grant_id":"\(grantID)","watch_credential":"\(watchCredential)","audience":"mesh-mailbox-watch","purpose":"notification-only"}
                """.utf8)
                return MeshHTTPResponse(statusCode: 200, headers: ["Content-Type": "application/json"], body: body, finalURL: request.url)
            }
            if path.hasSuffix("/revoke") {
                let body = Data(#"{"state":"revoked"}"#.utf8)
                return MeshHTTPResponse(statusCode: 200, headers: ["Content-Type": "application/json"], body: body, finalURL: request.url)
            }
            if path == "/api/v1/mailbox/watch" {
                switch nextPoll {
                case .success(let response):
                    let events = response.events.map {
                        "{\"agent_id\":\"\($0.agentID)\",\"high_watermark\":\($0.highWatermark)}"
                    }.joined(separator: ",")
                    let body = Data("{\"cursor\":\(response.cursor),\"events\":[\(events)]}".utf8)
                    return MeshHTTPResponse(statusCode: 200, headers: ["Content-Type": "application/json"], body: body, finalURL: request.url)
                case .resync(let restart):
                    let body = Data("{\"error\":\"resync_required\",\"restart_cursor\":\(restart),\"message\":\"Watch cursor is below the retained floor.\"}".utf8)
                    return MeshHTTPResponse(statusCode: 409, headers: ["Content-Type": "application/json"], body: body, finalURL: request.url)
                }
            }
            if path == "/api/v1/agents/me" {
                let auth = request.headers["Authorization"] ?? ""
                let isMember = auth.contains(String(repeating: "b", count: 64))
                let agentID = isMember ? memberAgentID.value : actorAgentID.value
                let handle = isMember ? "hermes-mailbox-live" : "codex-mailbox-live"
                let name = isMember ? "Hermes" : "Codex"
                let body = Data("""
                {"agent":{"id":"\(agentID)","name":"\(name)","handle":"\(handle)","registrationMode":"mailbox","endpointUrl":"https://thetriangle.dev/api/v1/mailbox"}}
                """.utf8)
                return MeshHTTPResponse(statusCode: 200, headers: ["Content-Type": "application/json"], body: body, finalURL: request.url)
            }
            if path.hasPrefix("/api/v1/agents/") {
                let agentID = path.split(separator: "/").last.map(String.init) ?? actorAgentID.value
                let handle = agentID == memberAgentID.value ? "hermes-mailbox-live" : "codex-mailbox-live"
                let body = Data("""
                {"agent":{"id":"\(agentID)","name":"Agent","handle":"\(handle)","registrationMode":"mailbox","endpointUrl":"https://thetriangle.dev/api/v1/mailbox"}}
                """.utf8)
                return MeshHTTPResponse(statusCode: 200, headers: ["Content-Type": "application/json"], body: body, finalURL: request.url)
            }
            throw MeshClientError.transportUnavailable
        }
    }

    private func jsonArray(_ values: [String]) -> String {
        "[" + values.map { "\"\($0)\"" }.joined(separator: ",") + "]"
    }
}
