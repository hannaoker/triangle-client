import Foundation
@_spi(EnrollmentTesting) @_spi(ReservationTesting) import TriangleMailboxCore

public enum EnrollmentContractCases {
    public struct ContractCase: Sendable {
        public let name: String
        public let run: @Sendable () async throws -> Void
    }

    public static let canary = "mesh_" + String(repeating: "c", count: 64)
    private static let agentID = "agent_" + String(repeating: "a", count: 32)

    public static let all: [ContractCase] = [
        .init(name: "admission header and strict metadata", run: admissionHeaderAndMetadata),
        .init(name: "enrollment preflight and reservation", run: enrollmentPreflightAndReservation),
        .init(name: "store before identity verification", run: storeBeforeVerify),
        .init(name: "sanitized enrollment output", run: sanitizedOutput),
        .init(name: "identity mismatch fails closed", run: identityMismatch),
        .init(name: "registered but not installed", run: registeredNotInstalled),
        .init(name: "ambiguous registration is never retried", run: ambiguousRegistration),
        .init(name: "registration HTTP outcomes are classified", run: registrationHTTPOutcomes),
        .init(name: "registered and installed but offline", run: registeredInstalledOffline),
        .init(name: "installed identity mismatch is preserved", run: installedIdentityMismatch),
        .init(name: "installed authentication rejection is preserved", run: installedAuthenticationRejection),
        .init(name: "invalid remote responses fail closed", run: invalidResponses),
        .init(name: "status verifies durable binding", run: statusVerification),
        .init(name: "status reports bounded offline state", run: offlineStatus),
        .init(name: "status reports missing and locked local profiles", run: localStatusStates),
        .init(name: "URLSession transport enforces the wire contract", run: urlSessionTransportContract),
        .init(name: "stored credentials require fresh verification", run: verifiedCredentialGate),
        .init(name: "registration contract is exact", run: exactRegistrationContract),
        .init(name: "durable enrollment lifecycle survives restart", run: durableEnrollmentLifecycle),
        .init(name: "journal and Keychain state reconcile consistently", run: journalKeychainReconciliation),
        .init(name: "enrollment diagnostics redact secrets", run: diagnosticsRedactSecrets),
    ]

    public static func durableEnrollmentLifecycle() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("triangle-journal-\(UUID().uuidString)")
        let lockRoot = root.appendingPathComponent("locks")
        let journalRoot = root.appendingPathComponent("journal")
        try FileManager.default.createDirectory(at: lockRoot, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try FileManager.default.createDirectory(at: journalRoot, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        defer { try? FileManager.default.removeItem(at: root) }
        let profile = try ProfileName("codex-mailbox-live")
        let origin = try MeshOrigin("https://thetriangle.dev")

        for scenario in ["outcome_unknown", "registered_not_installed"] {
            let scenarioRoot = journalRoot.appendingPathComponent(scenario)
            try FileManager.default.createDirectory(at: scenarioRoot, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
            let journal = FileEnrollmentJournal(testRoot: scenarioRoot)
            let reservation = FileEnrollmentReservation(testRoot: lockRoot)
            let firstTransport: any MeshTransport = scenario == "outcome_unknown" ? ScriptedTransport([]) : ScriptedTransport([response(201, registrationJSON())])
            let firstStore: any CredentialStore = scenario == "outcome_unknown" ? InMemoryCredentialStore() : FailingCreateStore()
            let first = try await EnrollmentService(store: firstStore, transport: firstTransport, reservation: reservation, journal: journal)
                .enroll(profile: profile, origin: origin, inputData: inputJSON())
            try expect(first.mustNotReregister, "\(scenario) did not prohibit re-registration")
            let restartTransport = ScriptedTransport([])
            let restarted = try await EnrollmentService(
                store: firstStore, transport: restartTransport,
                reservation: FileEnrollmentReservation(testRoot: lockRoot), journal: FileEnrollmentJournal(testRoot: scenarioRoot)
            ).enroll(profile: profile, origin: origin, inputData: inputJSON())
            try expect(restarted.mustNotReregister && restartTransport.requests.isEmpty, "fresh \(scenario) service issued POST")
        }

        let pendingRoot = journalRoot.appendingPathComponent("pending")
        try FileManager.default.createDirectory(at: pendingRoot, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        let pendingJournal = FileEnrollmentJournal(testRoot: pendingRoot)
        try pendingJournal.write(.testing(profile: profile, origin: origin, state: .pending, agentID: nil, handle: nil, reasonCode: "registration_started"))
        let pendingTransport = ScriptedTransport([])
        let pending = try await EnrollmentService(
            store: InMemoryCredentialStore(), transport: pendingTransport,
            reservation: FileEnrollmentReservation(testRoot: lockRoot), journal: pendingJournal
        ).enroll(profile: profile, origin: origin, inputData: inputJSON())
        try expect(pending.mustNotReregister && pendingTransport.requests.isEmpty, "pending journal did not block restart")

        let quarantineJournal = InMemoryEnrollmentJournal()
        let quarantineStore = InMemoryCredentialStore()
        _ = try await EnrollmentService(
            store: quarantineStore, transport: ScriptedTransport([response(201, registrationJSON(protocolVersion: "1.0"))]),
            reservation: InMemoryEnrollmentReservation(), journal: quarantineJournal
        ).enroll(profile: profile, origin: origin, inputData: inputJSON())
        let gateTransport = ScriptedTransport([response(200, meJSON())])
        let quarantinedGate = VerifiedCredentialGate(
            store: quarantineStore, transport: gateTransport,
            reservation: InMemoryEnrollmentReservation(), journal: quarantineJournal
        )
        try await expectCredentialGateError(.journalIneligible, "quarantined credential was released") {
            try await quarantinedGate.credential(for: profile)
        }
        try expect(gateTransport.requests.isEmpty, "quarantined gate reached /agents/me")

        let pendingVerificationJournal = InMemoryEnrollmentJournal()
        let pendingStore = InMemoryCredentialStore()
        try pendingStore.create(binding(), for: profile)
        try pendingVerificationJournal.write(.testing(
            profile: profile, origin: origin, state: .pendingVerification,
            agentID: try AgentID(agentID), handle: try MailboxHandle("codex-mailbox-live"), reasonCode: "verification_offline"
        ))
        let resumedGate = VerifiedCredentialGate(
            store: pendingStore, transport: ScriptedTransport([response(200, meJSON())]),
            reservation: InMemoryEnrollmentReservation(), journal: pendingVerificationJournal
        )
        _ = try await resumedGate.credential(for: profile)
        try expect(try pendingVerificationJournal.read(for: profile)?.state == .verified, "pending verification was not promoted")

        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [FixtureURLProtocol.self]
        for (status, expected) in [(503, ProfileVerificationStatus.registrationOutcomeUnknown), (408, .registrationOutcomeUnknown), (201, .verificationFailed)] {
            for fixture in [FixtureURLProtocol.Fixture.declaredOversized(status: status), .streamedOversized(status: status)] {
                FixtureURLProtocol.reset([fixture])
                let result = try await EnrollmentService(
                    store: InMemoryCredentialStore(), transport: URLSessionMeshTransport(configuration: configuration),
                    reservation: InMemoryEnrollmentReservation(), journal: InMemoryEnrollmentJournal()
                ).enroll(profile: profile, origin: origin, inputData: inputJSON())
                try expect(result.status == expected, "oversized HTTP \(status) classification changed")
            }
        }
        try expect(!String(describing: try pendingVerificationJournal.read(for: profile)).contains(canary), "journal diagnostics exposed secret")
    }

    public static func journalKeychainReconciliation() async throws {
        let profile = try ProfileName("codex-mailbox-live")
        let origin = try MeshOrigin("https://thetriangle.dev")
        let installedStates: Set<EnrollmentJournalState> = [.pendingVerification, .quarantined, .verified]

        for state in EnrollmentJournalState.allCases {
            let journal = InMemoryEnrollmentJournal()
            try journal.write(.testing(
                profile: profile, origin: origin, state: state,
                agentID: installedStates.contains(state) ? AgentID(agentID) : nil,
                handle: installedStates.contains(state) ? MailboxHandle("codex-mailbox-live") : nil,
                reasonCode: state == .quarantined ? "identity_mismatch" : "test_state"
            ))

            let missingTransport = ScriptedTransport([])
            let missing = try await EnrollmentService(
                store: InMemoryCredentialStore(), transport: missingTransport,
                reservation: InMemoryEnrollmentReservation(), journal: journal
            ).status(profile: profile)
            if state == .pending || state == .outcomeUnknown {
                try expect(missing.status == .registrationOutcomeUnknown, "\(state) restart status collapsed")
                try expect(missing.operatorAction == .confirmRegistrationOutcome, "\(state) restart action collapsed")
                try expect(missing.credentialInstalled == false && missing.identityCreated == nil, "\(state) restart certainty changed")
            } else if state == .registeredNotInstalled {
                try expect(missing.status == .registeredNotInstalled && missing.operatorAction == .preserveRecoveryDetails, "registered-not-installed action collapsed")
                try expect(missing.credentialInstalled == false, "registered-not-installed claimed a credential")
            } else {
                try expect(missing.status == .profileStateInconsistent, "installed journal without Keychain was not inconsistent")
                try expect(missing.credentialInstalled == false && missing.mustNotReregister, "missing Keychain inconsistency was unsafe")
            }
            try expect(missingTransport.requests.isEmpty, "missing Keychain state reached network")

            let lockedJournal = InMemoryEnrollmentJournal()
            try lockedJournal.write(.testing(
                profile: profile, origin: origin, state: state,
                agentID: installedStates.contains(state) ? AgentID(agentID) : nil,
                handle: installedStates.contains(state) ? MailboxHandle("codex-mailbox-live") : nil,
                reasonCode: "test_state"
            ))
            let locked = try await EnrollmentService(
                store: ThrowingReadStore(.interactionNotAllowed), transport: ScriptedTransport([]),
                reservation: InMemoryEnrollmentReservation(), journal: lockedJournal
            ).status(profile: profile)
            try expect(locked.status == .localAuthorizationRequired && locked.credentialInstalled == nil, "\(state) locked Keychain made a false installation claim")
        }

        let unmanagedStore = InMemoryCredentialStore()
        try unmanagedStore.create(binding(), for: profile)
        let unmanagedTransport = ScriptedTransport([])
        let unmanaged = try await EnrollmentService(
            store: unmanagedStore, transport: unmanagedTransport,
            reservation: InMemoryEnrollmentReservation(), journal: InMemoryEnrollmentJournal()
        ).status(profile: profile)
        try expect(unmanaged.status == .profileStateInconsistent && unmanaged.credentialInstalled == true, "unmanaged Keychain credential was trusted")
        try expect(unmanagedTransport.requests.isEmpty, "unmanaged credential reached /agents/me")

        let absent = try await EnrollmentService(
            store: InMemoryCredentialStore(), transport: ScriptedTransport([]),
            reservation: InMemoryEnrollmentReservation(), journal: InMemoryEnrollmentJournal()
        ).status(profile: profile)
        try expect(absent.status == .profileNotFound && absent.credentialInstalled == false, "genuinely absent profile was not enrollable")

        for state in EnrollmentJournalState.allCases {
            let journal = InMemoryEnrollmentJournal()
            let store = InMemoryCredentialStore()
            let stateIsInstalled = installedStates.contains(state)
            try journal.write(.testing(
                profile: profile, origin: origin, state: state,
                agentID: stateIsInstalled ? AgentID(agentID) : nil,
                handle: stateIsInstalled ? MailboxHandle("codex-mailbox-live") : nil,
                reasonCode: state == .quarantined ? "identity_mismatch" : "test_state"
            ))
            try store.create(binding(), for: profile)
            let enrollTransport = ScriptedTransport([])
            let blockedEnrollment = try await EnrollmentService(
                store: store, transport: enrollTransport,
                reservation: InMemoryEnrollmentReservation(), journal: journal
            ).enroll(profile: profile, origin: origin, inputData: inputJSON())
            try expect(blockedEnrollment.mustNotReregister && enrollTransport.requests.isEmpty, "\(state) present-state restart reached registration")
            let statusTransport = ScriptedTransport(state == .pendingVerification || state == .verified ? [response(200, meJSON())] : [])
            let status = try await EnrollmentService(
                store: store, transport: statusTransport,
                reservation: InMemoryEnrollmentReservation(), journal: journal
            ).status(profile: profile)
            let gateTransport = ScriptedTransport([response(200, meJSON())])
            let gate = VerifiedCredentialGate(
                store: store, transport: gateTransport,
                reservation: InMemoryEnrollmentReservation(), journal: journal
            )
            if state == .pendingVerification || state == .verified {
                try expect(status.status == .verified, "\(state) status did not verify")
                _ = try await gate.credential(for: profile)
            } else {
                try expect(status.status != .verified, "\(state) status became usable")
                try await expectAnyError("\(state) gate released credential") { try await gate.credential(for: profile) }
                try expect(gateTransport.requests.isEmpty, "\(state) gate reached /agents/me")
            }
        }

        let quarantineJournal = InMemoryEnrollmentJournal()
        let quarantineStore = InMemoryCredentialStore()
        try quarantineStore.create(binding(), for: profile)
        try quarantineJournal.write(.testing(
            profile: profile, origin: origin, state: .quarantined,
            agentID: AgentID(agentID), handle: MailboxHandle("codex-mailbox-live"), reasonCode: "identity_mismatch"
        ))
        let quarantineTransport = ScriptedTransport([response(200, meJSON())])
        let quarantined = try await EnrollmentService(
            store: quarantineStore, transport: quarantineTransport,
            reservation: InMemoryEnrollmentReservation(), journal: quarantineJournal
        ).status(profile: profile)
        try expect(quarantined.status == .identityMismatch && quarantineTransport.requests.isEmpty, "quarantine was silently cleared by valid identity")
    }

    public static func enrollmentPreflightAndReservation() async throws {
        let profile = try ProfileName("codex-mailbox-live")
        let existingStore = InMemoryCredentialStore()
        try existingStore.create(binding(), for: profile)
        let existingTransport = ScriptedTransport([])
        let existing = try await EnrollmentService(store: existingStore, transport: existingTransport).enroll(
            profile: profile,
            origin: MeshOrigin("https://thetriangle.dev"),
            inputData: inputJSON()
        )
        try expect(existing.status == .profileStateInconsistent, "unmanaged existing profile did not block enrollment")
        try expect(existingTransport.requests.isEmpty, "existing profile reached registration network")
        try expect(try CLIOutputRenderer.render(existing).exitCode != 0, "inconsistent profile exited successfully")

        let lockedTransport = ScriptedTransport([])
        let locked = try await EnrollmentService(store: ThrowingReadStore(.interactionNotAllowed), transport: lockedTransport).enroll(
            profile: profile,
            origin: MeshOrigin("https://thetriangle.dev"),
            inputData: inputJSON()
        )
        try expect(locked.status == .localAuthorizationRequired, "locked preflight did not fail closed")
        try expect(lockedTransport.requests.isEmpty, "locked preflight reached registration network")

        let reservation = InMemoryEnrollmentReservation()
        let store = InMemoryCredentialStore()
        let transport = BlockingEnrollmentTransport()
        let firstService = EnrollmentService(store: store, transport: transport, reservation: reservation)
        let secondService = EnrollmentService(store: store, transport: transport, reservation: reservation)
        let first = Task {
            try await firstService.enroll(profile: profile, origin: MeshOrigin("https://thetriangle.dev"), inputData: inputJSON())
        }
        await transport.waitUntilRegistrationStarted()
        let second = try await secondService.enroll(profile: profile, origin: MeshOrigin("https://thetriangle.dev"), inputData: inputJSON())
        try expect([.alreadyInProgress, .profileExists].contains(second.status), "concurrent same-profile enrollment was not serialized")
        let registrationCalls = await transport.registrationCalls
        try expect(registrationCalls == 1, "concurrent enrollment issued a second POST")
        await transport.releaseRegistration()
        let firstResult = try await first.value
        try expect(firstResult.status == .verified, "reserved enrollment did not complete")

        let alpha = try reservation.acquire(for: ProfileName("alpha-profile"))
        let beta = try reservation.acquire(for: ProfileName("beta-profile"))
        alpha.release()
        beta.release()

        let unsafeRoot = FileManager.default.temporaryDirectory.appendingPathComponent("triangle-reservation-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: unsafeRoot, withIntermediateDirectories: false)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: unsafeRoot.path)
        let fileReservation = FileEnrollmentReservation(testRoot: unsafeRoot)
        let fileLease = try fileReservation.acquire(for: profile)
        try expectReservationError(.alreadyInProgress, "file reservation admitted concurrent same-profile enrollment") {
            try fileReservation.acquire(for: profile)
        }
        let otherFileLease = try fileReservation.acquire(for: ProfileName("other-profile"))
        fileLease.release()
        otherFileLease.release()

        let symlinkProfile = try ProfileName("symlink-profile")
        let symlinkPath = unsafeRoot.appendingPathComponent(FileEnrollmentReservation.lockFileName(for: symlinkProfile))
        try FileManager.default.createSymbolicLink(atPath: symlinkPath.path, withDestinationPath: "/dev/null")
        try expectReservationError(.unsafeReservation, "symlink reservation file was accepted") {
            try fileReservation.acquire(for: symlinkProfile)
        }
        try FileManager.default.setAttributes([.posixPermissions: 0o777], ofItemAtPath: unsafeRoot.path)
        defer { try? FileManager.default.removeItem(at: unsafeRoot) }
        let unsafe = FileEnrollmentReservation(testRoot: unsafeRoot)
        try expectReservationError(.unsafeReservation, "unsafe reservation directory was accepted") {
            try unsafe.acquire(for: profile)
        }
    }

    public static func admissionHeaderAndMetadata() async throws {
        let transport = ScriptedTransport([
            response(201, registrationJSON()),
            response(200, meJSON()),
        ])
        let service = EnrollmentService(store: InMemoryCredentialStore(), transport: transport)
        _ = try await service.enroll(
            profile: ProfileName("codex-mailbox-live"),
            origin: MeshOrigin("https://thetriangle.dev"),
            inputData: inputJSON()
        )

        let requests = transport.requests
        try expect(requests.count == 2, "enrollment did not make exactly two requests")
        let registration = requests[0]
        try expect(registration.method == "POST", "registration method changed")
        try expect(registration.url.absoluteString == "https://thetriangle.dev/api/v1/agents/register-mailbox", "registration path changed")
        try expect(registration.headers["X-Mesh-Admission-Token"] == canary, "admission header missing")
        try expect(registration.headers["Authorization"] == nil, "registration sent bearer authorization")
        let body = try JSONSerialization.jsonObject(with: registration.body) as? [String: Any]
        try expect(Set(body?.keys.map { $0 } ?? []) == ["handle", "name", "description", "capabilities"], "registration body schema changed")
        try expect(!String(decoding: registration.body, as: UTF8.self).contains(canary), "admission token entered request body")

        let me = requests[1]
        try expect(me.method == "GET", "identity method changed")
        try expect(me.url.absoluteString == "https://thetriangle.dev/api/v1/agents/me", "identity path changed")
        try expect(me.headers["Authorization"] == "Bearer \(canary)", "identity bearer missing")
        try expect(me.headers["X-Mesh-Admission-Token"] == nil, "admission token leaked to identity request")
    }

    public static func storeBeforeVerify() async throws {
        let store = RecordingStore()
        let transport = ClosureTransport { request in
            if request.url.path.hasSuffix("/register-mailbox") {
                return response(201, registrationJSON())
            }
            guard store.didCreate else { throw ContractFailure("identity was checked before persistence") }
            return response(200, meJSON())
        }
        let service = EnrollmentService(store: store, transport: transport)
        let result = try await service.enroll(
            profile: ProfileName("codex-mailbox-live"),
            origin: MeshOrigin("https://thetriangle.dev"),
            inputData: inputJSON()
        )
        try expect(result.status == .verified, "valid enrollment was not verified")
        try expect(try store.read(for: ProfileName("codex-mailbox-live")).agentID.value == agentID, "stored identity changed")
    }

    public static func sanitizedOutput() async throws {
        let service = EnrollmentService(
            store: InMemoryCredentialStore(),
            transport: ScriptedTransport([response(201, registrationJSON()), response(200, meJSON())])
        )
        let result = try await service.enroll(
            profile: ProfileName("codex-mailbox-live"),
            origin: MeshOrigin("https://thetriangle.dev"),
            inputData: inputJSON()
        )
        let encoded = try JSONEncoder().encode(result)
        let output = String(decoding: encoded, as: UTF8.self)
        try expect(output.contains("codex-mailbox-live"), "sanitized result omitted profile")
        try expect(output.contains(agentID), "sanitized result omitted agent ID")
        try expect(output.contains("verified"), "sanitized result omitted status")
        try expect(!output.contains(canary), "sanitized result exposed permanent token")
        try expect(!output.lowercased().contains("admission"), "sanitized result exposed admission metadata")
        let rendered = try CLIOutputRenderer.render(result)
        try expect(!String(decoding: rendered.stdout, as: UTF8.self).contains(canary), "CLI stdout exposed permanent token")
        try expect(!String(decoding: rendered.stderr, as: UTF8.self).contains(canary), "CLI stderr exposed permanent token")
    }

    public static func identityMismatch() async throws {
        let store = InMemoryCredentialStore()
        let mismatch = meJSON(agentID: "agent_" + String(repeating: "b", count: 32))
        let service = EnrollmentService(
            store: store,
            transport: ScriptedTransport([response(201, registrationJSON()), response(200, mismatch)])
        )
        let result = try await service.enroll(
            profile: ProfileName("codex-mailbox-live"),
            origin: MeshOrigin("https://thetriangle.dev"),
            inputData: inputJSON()
        )
        try expect(result.status == .identityMismatch, "identity mismatch was not reported")
    }

    public static func registeredNotInstalled() async throws {
        let store = FailingCreateStore()
        let transport = ScriptedTransport([response(201, registrationJSON())])
        let service = EnrollmentService(store: store, transport: transport)
        let result = try await service.enroll(
            profile: ProfileName("codex-mailbox-live"),
            origin: MeshOrigin("https://thetriangle.dev"),
            inputData: inputJSON()
        )
        try expect(result.status == .registeredNotInstalled, "persistence failure was not distinguished")
        try expect(result.identityCreated == true, "registered result did not preserve server creation state")
        try expect(result.credentialInstalled == false, "failed persistence claimed an installed credential")
        try expect(result.mustNotReregister, "registered result allowed unsafe re-registration")
        try expect(transport.requests.count == 1, "registration was retried after the token could not be stored")
    }

    public static func registeredInstalledOffline() async throws {
        let transport = ScriptedTransport([response(201, registrationJSON())])
        let service = EnrollmentService(store: InMemoryCredentialStore(), transport: transport)
        let result = try await service.enroll(
            profile: ProfileName("codex-mailbox-live"),
            origin: MeshOrigin("https://thetriangle.dev"),
            inputData: inputJSON()
        )
        try expect(result.status == .offlineUnverified, "post-registration outage did not preserve an offline state")
        try expect(result.identityCreated == true && result.credentialInstalled == true && result.mustNotReregister, "post-registration outage lost irreversible state")
        try expect(transport.requests.count == 2, "verification transport was retried")
    }

    public static func ambiguousRegistration() async throws {
        let transport = ScriptedTransport([])
        let service = EnrollmentService(store: InMemoryCredentialStore(), transport: transport)
        let result = try await service.enroll(
            profile: ProfileName("codex-mailbox-live"),
            origin: MeshOrigin("https://thetriangle.dev"),
            inputData: inputJSON()
        )
        try expect(result.status == .registrationOutcomeUnknown, "ambiguous POST outcome was not distinguished")
        try expect(result.identityCreated == nil, "ambiguous POST outcome guessed identity creation")
        try expect(result.credentialInstalled == false && result.mustNotReregister, "ambiguous POST outcome allowed retry or guessed installation")
        try expect(transport.requests.count == 1, "ambiguous registration was retried")
        let rendered = try CLIOutputRenderer.render(result)
        let stdout = String(decoding: rendered.stdout, as: UTF8.self)
        try expect(stdout.contains("\"identityCreated\":null"), "ambiguous CLI output did not encode identity creation as unknown")
        try expect(stdout.contains("registration_outcome_unknown"), "ambiguous CLI output omitted distinct status")
        try expect(rendered.exitCode != 0, "ambiguous CLI outcome exited successfully")
        try expect(!stdout.contains(canary), "ambiguous CLI output exposed admission token")
    }

    public static func registrationHTTPOutcomes() async throws {
        for status in [500, 503, 408] {
            let response = MeshHTTPResponse(
                statusCode: status,
                headers: ["Content-Type": "application/json"],
                body: Data("{\"error\":\"temporary\"}".utf8),
                finalURL: URL(string: "https://thetriangle.dev/api/v1/agents/register-mailbox")!
            )
            let result = try await EnrollmentService(store: InMemoryCredentialStore(), transport: ScriptedTransport([response])).enroll(
                profile: ProfileName("codex-mailbox-live"), origin: MeshOrigin("https://thetriangle.dev"), inputData: inputJSON()
            )
            try expect(result.status == .registrationOutcomeUnknown, "HTTP \(status) was not ambiguous")
            try expect(result.identityCreated == nil && result.mustNotReregister && !result.safeToRetry, "HTTP \(status) allowed unsafe retry")
        }
        for status in [400, 403, 409, 429] {
            let response = MeshHTTPResponse(
                statusCode: status,
                headers: ["Content-Type": "application/json"],
                body: Data("{\"error\":\"rejected\"}".utf8),
                finalURL: URL(string: "https://thetriangle.dev/api/v1/agents/register-mailbox")!
            )
            let result = try await EnrollmentService(store: InMemoryCredentialStore(), transport: ScriptedTransport([response])).enroll(
                profile: ProfileName("codex-mailbox-live"), origin: MeshOrigin("https://thetriangle.dev"), inputData: inputJSON()
            )
            try expect(result.status == .registrationRejected, "HTTP \(status) was not definitely rejected")
            try expect(result.identityCreated == false && !result.mustNotReregister && result.safeToRetry, "HTTP \(status) retry contract changed")
            try expect(
                result.operatorAction == (status == 429 ? .waitBeforeRetry : .correctRegistrationRequest),
                "HTTP \(status) corrective action changed"
            )
        }
    }

    public static func installedIdentityMismatch() async throws {
        let store = InMemoryCredentialStore()
        let transport = ScriptedTransport([
            response(201, registrationJSON()),
            response(200, meJSON(agentID: "agent_" + String(repeating: "b", count: 32))),
        ])
        let result = try await EnrollmentService(store: store, transport: transport).enroll(
            profile: ProfileName("codex-mailbox-live"),
            origin: MeshOrigin("https://thetriangle.dev"),
            inputData: inputJSON()
        )
        try expect(result.status == .identityMismatch, "installed mismatch was not structured")
        try expect(result.credentialInstalled == true && result.mustNotReregister, "mismatch did not preserve installed state")
        try expect(try store.read(for: ProfileName("codex-mailbox-live")).agentID.value == agentID, "mismatch deleted or replaced installed profile")
        try expect(transport.requests.count == 2, "mismatch triggered a retry")
    }

    public static func installedAuthenticationRejection() async throws {
        let store = InMemoryCredentialStore()
        let rejected = MeshHTTPResponse(
            statusCode: 401,
            headers: ["Content-Type": "application/json"],
            body: Data("{\"error\":\"agent_auth_required\"}".utf8),
            finalURL: URL(string: "https://thetriangle.dev/api/v1/agents/me")!
        )
        let transport = ScriptedTransport([response(201, registrationJSON()), rejected])
        let result = try await EnrollmentService(store: store, transport: transport).enroll(
            profile: ProfileName("codex-mailbox-live"),
            origin: MeshOrigin("https://thetriangle.dev"),
            inputData: inputJSON()
        )
        try expect(result.status == .verificationFailed, "authentication rejection was not structured")
        try expect(result.credentialInstalled == true && result.mustNotReregister, "authentication rejection lost installed state")
        try expect(try store.read(for: ProfileName("codex-mailbox-live")).handle.value == "codex-mailbox-live", "authentication rejection removed profile")
    }

    public static func invalidResponses() async throws {
        let oversized = Data(repeating: 0x20, count: MeshClient.maximumResponseBytes + 1)
        let cases: [(String, MeshHTTPResponse)] = [
            ("malformed", response(201, Data("{".utf8))),
            ("oversized", MeshHTTPResponse(statusCode: 201, headers: ["Content-Type": "application/json"], body: oversized, finalURL: URL(string: "https://thetriangle.dev/api/v1/agents/register-mailbox")!)),
            ("redirect", MeshHTTPResponse(statusCode: 302, headers: ["Location": "https://evil.example/steal"], body: Data(), finalURL: URL(string: "https://thetriangle.dev/api/v1/agents/register-mailbox")!)),
            ("cross origin", MeshHTTPResponse(statusCode: 201, headers: ["Content-Type": "application/json"], body: registrationJSON(), finalURL: URL(string: "https://evil.example/api/v1/agents/register-mailbox")!)),
            ("plaintext", MeshHTTPResponse(statusCode: 201, headers: ["Content-Type": "text/plain"], body: registrationJSON(), finalURL: URL(string: "https://thetriangle.dev/api/v1/agents/register-mailbox")!)),
            ("unknown field", response(201, registrationJSON(extra: ",\"unexpected\":true"))),
        ]
        for (name, badResponse) in cases {
            let service = EnrollmentService(store: InMemoryCredentialStore(), transport: ScriptedTransport([badResponse]))
            if badResponse.statusCode == 201 {
                let result = try await service.enroll(
                    profile: ProfileName("codex-mailbox-live"),
                    origin: MeshOrigin("https://thetriangle.dev"),
                    inputData: inputJSON()
                )
                try expect(result.status == .verificationFailed, "\(name) success response was not fail-closed")
                try expect(result.identityCreated == true && result.credentialInstalled == false && result.mustNotReregister, "\(name) success response allowed re-registration")
            } else {
                let result = try await service.enroll(
                    profile: ProfileName("codex-mailbox-live"),
                    origin: MeshOrigin("https://thetriangle.dev"),
                    inputData: inputJSON()
                )
                try expect(result.status == .registrationOutcomeUnknown && result.mustNotReregister, "\(name) was not quarantined as ambiguous")
            }
        }
    }

    public static func statusVerification() async throws {
        let store = InMemoryCredentialStore()
        let profile = try ProfileName("codex-mailbox-live")
        try store.create(binding(), for: profile)
        let journal = try installedJournal(profile: profile)
        let service = EnrollmentService(
            store: store, transport: ScriptedTransport([response(200, meJSON())]),
            reservation: InMemoryEnrollmentReservation(), journal: journal
        )
        let result = try await service.status(profile: profile)
        try expect(result.status == .verified, "stored profile status was not verified")
        try expect(result.agentID == agentID, "status returned wrong identity")
    }

    public static func offlineStatus() async throws {
        let store = InMemoryCredentialStore()
        let profile = try ProfileName("codex-mailbox-live")
        try store.create(binding(), for: profile)
        let service = EnrollmentService(
            store: store, transport: UnavailableTransport(),
            reservation: InMemoryEnrollmentReservation(), journal: try installedJournal(profile: profile)
        )
        let result = try await service.status(profile: profile)
        try expect(result.status == .offlineUnverified, "offline status was not bounded")
        try expect(result.identityCreated == true && result.credentialInstalled == true && result.mustNotReregister, "offline status lost durable state")
        try expect(!String(decoding: try JSONEncoder().encode(result), as: UTF8.self).contains(canary), "offline status exposed token")
    }

    public static func localStatusStates() async throws {
        let missing = try await EnrollmentService(store: InMemoryCredentialStore(), transport: UnavailableTransport())
            .status(profile: ProfileName("missing-profile"))
        try expect(missing.status == .profileNotFound, "missing profile did not return profile_not_found")
        try expect(missing.identityCreated == false && missing.credentialInstalled == false && !missing.mustNotReregister, "missing profile claimed durable identity state")
        try expect(try CLIOutputRenderer.render(missing).exitCode != 0, "profile_not_found exited successfully")

        let locked = try await EnrollmentService(store: ThrowingReadStore(.interactionNotAllowed), transport: UnavailableTransport())
            .status(profile: ProfileName("codex-mailbox-live"))
        try expect(locked.status == .localAuthorizationRequired, "locked Keychain did not request local authorization")
        try expect(locked.profile == "codex-mailbox-live", "locked status omitted profile")

        let profile = try ProfileName("codex-mailbox-live")
        let mismatchStore = InMemoryCredentialStore()
        try mismatchStore.create(binding(), for: profile)
        let mismatch = try await EnrollmentService(
            store: mismatchStore,
            transport: ScriptedTransport([response(200, meJSON(handle: "other-mailbox"))]),
            reservation: InMemoryEnrollmentReservation(), journal: try installedJournal(profile: profile)
        ).status(profile: profile)
        try expect(mismatch.status == .identityMismatch, "status did not report remote identity mismatch")
        try expect(mismatch.credentialInstalled == true && mismatch.mustNotReregister, "status mismatch lost installed state")

        let rejectionStore = InMemoryCredentialStore()
        try rejectionStore.create(binding(), for: profile)
        let rejected = MeshHTTPResponse(
            statusCode: 403,
            headers: ["Content-Type": "application/json"],
            body: Data("{\"error\":\"forbidden\"}".utf8),
            finalURL: URL(string: "https://thetriangle.dev/api/v1/agents/me")!
        )
        let verificationFailure = try await EnrollmentService(
            store: rejectionStore,
            transport: ScriptedTransport([rejected]),
            reservation: InMemoryEnrollmentReservation(), journal: try installedJournal(profile: profile)
        ).status(profile: profile)
        try expect(verificationFailure.status == .verificationFailed, "status did not report authentication rejection")
    }

    public static func urlSessionTransportContract() async throws {
        FixtureURLProtocol.reset([
            .json(status: 201, url: URL(string: "https://thetriangle.dev/api/v1/agents/register-mailbox")!, body: registrationJSON()),
            .json(status: 200, url: URL(string: "https://thetriangle.dev/api/v1/agents/me")!, body: meJSON()),
        ])
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [FixtureURLProtocol.self]
        let service = EnrollmentService(store: InMemoryCredentialStore(), transport: URLSessionMeshTransport(configuration: configuration))
        let result = try await service.enroll(
            profile: ProfileName("codex-mailbox-live"),
            origin: MeshOrigin("https://thetriangle.dev"),
            inputData: inputJSON()
        )
        try expect(result.status == .verified, "URLSession fixture enrollment failed")
        let requests = FixtureURLProtocol.requests
        try expect(requests.count == 2, "URLSession fixture request count changed")
        try expect(requests[0].value(forHTTPHeaderField: "X-Mesh-Admission-Token") == canary, "URLSession dropped admission header")
        try expect(requests[0].value(forHTTPHeaderField: "Authorization") == nil, "URLSession registration sent authorization")
        try expect(!String(decoding: requests[0].httpBody ?? Data(), as: UTF8.self).contains(canary), "URLSession registration body exposed admission token")
        try expect(requests[1].value(forHTTPHeaderField: "Authorization") == "Bearer \(canary)", "URLSession dropped bearer")

        for location in ["https://evil.example/steal", "http://evil.example/steal"] {
            FixtureURLProtocol.reset([.redirect(location: location)])
            let redirectTransport = URLSessionMeshTransport(configuration: configuration)
            try await expectMeshError(.redirectRejected, "URLSession followed redirect to \(location)") {
                try await redirectTransport.send(MeshHTTPRequest(
                    method: "GET",
                    url: URL(string: "https://thetriangle.dev/api/v1/agents/me")!,
                    headers: ["Authorization": "Bearer \(canary)", "X-Mesh-Admission-Token": canary]
                ))
            }
            try expect(FixtureURLProtocol.requests.count == 1, "redirect caused a second request")
            try expect(FixtureURLProtocol.redirectTargets.count == 1, "URLSession redirect delegate was not exercised")
        }

        FixtureURLProtocol.reset([.declaredOversized(status: 200)])
        try await expectMeshError(.responseTooLargeAfterResponse(statusCode: 200), "declared oversized response was accepted") {
            try await URLSessionMeshTransport(configuration: configuration).send(
                MeshHTTPRequest(method: "GET", url: URL(string: "https://thetriangle.dev/api")!, headers: [:])
            )
        }

        FixtureURLProtocol.reset([.streamedOversized(status: 200)])
        try await expectMeshError(.responseTooLargeAfterResponse(statusCode: 200), "streamed oversized response was accepted") {
            try await URLSessionMeshTransport(configuration: configuration).send(
                MeshHTTPRequest(method: "GET", url: URL(string: "https://thetriangle.dev/api")!, headers: [:])
            )
        }

        FixtureURLProtocol.reset([.plaintextJSON(status: 201, body: registrationJSON())])
        let plaintextResult = try await EnrollmentService(
            store: InMemoryCredentialStore(),
            transport: URLSessionMeshTransport(configuration: configuration)
        ).enroll(
            profile: ProfileName("codex-mailbox-live"),
            origin: MeshOrigin("https://thetriangle.dev"),
            inputData: inputJSON()
        )
        try expect(plaintextResult.status == .verificationFailed, "HTTPS text/plain registration response was accepted")
        try expect(plaintextResult.identityCreated == true && plaintextResult.mustNotReregister, "HTTPS text/plain response lost server creation state")

        FixtureURLProtocol.reset([])
        try await expectMeshError(.plaintextOrigin, "plaintext request origin was accepted") {
            try await URLSessionMeshTransport(configuration: configuration).send(
                MeshHTTPRequest(method: "GET", url: URL(string: "http://127.0.0.1/api")!, headers: [:])
            )
        }
        try expect(FixtureURLProtocol.requests.isEmpty, "plaintext origin reached the transport fixture")
    }

    public static func verifiedCredentialGate() async throws {
        let profile = try ProfileName("codex-mailbox-live")
        let store = InMemoryCredentialStore()
        try store.create(binding(), for: profile)
        let mismatchJournal = InMemoryEnrollmentJournal()
        try mismatchJournal.write(.testing(
            profile: profile, origin: MeshOrigin("https://thetriangle.dev"), state: .verified,
            agentID: AgentID(agentID), handle: MailboxHandle("codex-mailbox-live"), reasonCode: "identity_verified"
        ))

        let mismatchGate = VerifiedCredentialGate(
            store: store,
            transport: ScriptedTransport([response(200, meJSON(agentID: "agent_" + String(repeating: "b", count: 32)))]),
            reservation: InMemoryEnrollmentReservation(), journal: mismatchJournal
        )
        try await expectCredentialGateError(.identityMismatch, "mismatched identity released credential") {
            try await mismatchGate.credential(for: profile)
        }
        try expect(try store.read(for: profile).agentID.value == agentID, "mismatch deleted stored binding")

        let rejected = MeshHTTPResponse(
            statusCode: 401,
            headers: ["Content-Type": "application/json"],
            body: Data("{\"error\":\"agent_auth_required\"}".utf8),
            finalURL: URL(string: "https://thetriangle.dev/api/v1/agents/me")!
        )
        let rejectedJournal = InMemoryEnrollmentJournal()
        try rejectedJournal.write(.testing(
            profile: profile, origin: MeshOrigin("https://thetriangle.dev"), state: .verified,
            agentID: AgentID(agentID), handle: MailboxHandle("codex-mailbox-live"), reasonCode: "identity_verified"
        ))
        let freshGate = VerifiedCredentialGate(
            store: store, transport: ScriptedTransport([rejected]),
            reservation: InMemoryEnrollmentReservation(), journal: rejectedJournal
        )
        try await expectCredentialGateError(.verificationFailed, "authentication rejection released credential") {
            try await freshGate.credential(for: profile)
        }
        try expect(try store.read(for: profile).handle.value == "codex-mailbox-live", "auth rejection deleted stored binding")
    }

    public static func exactRegistrationContract() async throws {
        let cases: [(String, Data)] = [
            ("protocol version", registrationJSON(protocolVersion: "1.0")),
            ("protocol binding", registrationJSON(protocolBinding: "JSONRPC")),
            ("endpoint query", registrationJSON(endpointURL: "https://thetriangle.dev/api/v1/mailbox?leak=1")),
            ("endpoint path", registrationJSON(endpointURL: "https://thetriangle.dev/api/v1/mailbox/extra")),
            ("agent card query", registrationJSON(agentCardURL: "https://thetriangle.dev/api/v1/agents/\(agentID)?x=1")),
            ("agent card identity", registrationJSON(agentCardURL: "https://thetriangle.dev/api/v1/agents/agent_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")),
        ]
        for (name, body) in cases {
            let transport = ScriptedTransport([response(201, body)])
            let result = try await EnrollmentService(store: InMemoryCredentialStore(), transport: transport).enroll(
                profile: ProfileName("codex-mailbox-live"), origin: MeshOrigin("https://thetriangle.dev"), inputData: inputJSON()
            )
            try expect(result.status == .verificationFailed, "invalid \(name) contract was accepted")
            try expect(result.credentialInstalled == true && result.mustNotReregister, "invalid \(name) contract lost credential quarantine")
            try expect(transport.requests.count == 1, "invalid \(name) contract reached /agents/me")
        }
    }

    public static func diagnosticsRedactSecrets() async throws {
        let malformedInputs = [
            Data("{\"admissionToken\":\"\(canary)\"}".utf8),
            Data(repeating: 0x61, count: EnrollmentService.maximumInputBytes + 1),
        ]
        for input in malformedInputs {
            let service = EnrollmentService(store: InMemoryCredentialStore(), transport: ScriptedTransport([]))
            do {
                _ = try await service.enroll(
                    profile: ProfileName("codex-mailbox-live"),
                    origin: MeshOrigin("https://thetriangle.dev"),
                    inputData: input
                )
                throw ContractFailure("malformed enrollment input succeeded")
            } catch {
                let diagnostic = String(describing: error) + String(reflecting: error)
                try expect(!diagnostic.contains(canary), "error diagnostic exposed admission token")
            }
        }

        let request = MeshHTTPRequest(
            method: "POST",
            url: URL(string: "https://thetriangle.dev/api")!,
            headers: ["X-Mesh-Admission-Token": canary],
            body: Data(canary.utf8)
        )
        let response = MeshHTTPResponse(
            statusCode: 400,
            headers: ["X-Reflected": canary],
            body: Data(canary.utf8),
            finalURL: URL(string: "https://thetriangle.dev/api?reflected=\(canary)")!
        )
        var requestDump = ""
        dump(request, to: &requestDump)
        var responseDump = ""
        dump(response, to: &responseDump)
        for diagnostic in [
            String(describing: request), String(reflecting: request), requestDump,
            String(describing: response), String(reflecting: response), responseDump,
        ] {
            try expect(!diagnostic.contains(canary), "HTTP diagnostic exposed credential material")
        }
        let localFailure = CLIOutputRenderer.localValidationFailure
        let localFailureText = String(decoding: localFailure.stderr, as: UTF8.self)
        try expect(localFailureText.contains("local_validation_failed"), "local preflight failure was not distinct")
        try expect(localFailureText.contains("\"safeToRetry\":true"), "local preflight failure did not permit correction")
        try expect(localFailure.exitCode != 0, "local preflight failure exited successfully")

    }

    private static func inputJSON() -> Data {
        return Data("""
        {"admissionToken":"\(canary)","handle":"codex-mailbox-live","name":"Codex Mailbox Live","description":"Remote test agent","capabilities":["direct-messages"]}
        """.utf8)
    }

    private static func registrationJSON(
        extra: String = "",
        protocolVersion: String = "mailbox-v1",
        protocolBinding: String = "TRIANGLE",
        endpointURL: String = "https://thetriangle.dev/api/v1/mailbox",
        agentCardURL: String? = nil
    ) -> Data {
        let cardURL = agentCardURL ?? "https://thetriangle.dev/api/v1/agents/\(agentID)"
        return Data("""
        {"agent":{"id":"\(agentID)","handle":"codex-mailbox-live","name":"Codex Mailbox Live","description":"Remote test agent","endpointUrl":"\(endpointURL)","capabilities":["direct-messages"],"protocolVersion":"\(protocolVersion)","protocolBinding":"\(protocolBinding)","conformanceStatus":"unverified","registrationMode":"mailbox","agentCardUrl":"\(cardURL)"},"token":"\(canary)","warning":"Save this token now."\(extra)}
        """.utf8)
    }

    private static func meJSON(
        agentID: String = EnrollmentContractCases.agentID,
        handle: String = "codex-mailbox-live",
        mode: String = "mailbox"
    ) -> Data {
        Data("""
        {"agent":{"id":"\(agentID)","name":"Codex Mailbox Live","handle":"\(handle)","registrationMode":"\(mode)","endpointUrl":"https://thetriangle.dev/api/v1/mailbox"}}
        """.utf8)
    }

    private static func response(_ status: Int, _ body: Data) -> MeshHTTPResponse {
        MeshHTTPResponse(
            statusCode: status,
            headers: ["Content-Type": "application/json"],
            body: body,
            finalURL: URL(string: status == 200 ? "https://thetriangle.dev/api/v1/agents/me" : "https://thetriangle.dev/api/v1/agents/register-mailbox")!
        )
    }

    private static func binding() throws -> CredentialBinding {
        try CredentialBinding(
            origin: MeshOrigin("https://thetriangle.dev"),
            agentID: AgentID(agentID),
            handle: MailboxHandle("codex-mailbox-live"),
            token: MeshToken(canary)
        )
    }

    private static func installedJournal(profile: ProfileName, state: EnrollmentJournalState = .verified) throws -> InMemoryEnrollmentJournal {
        let journal = InMemoryEnrollmentJournal()
        try journal.write(.testing(
            profile: profile, origin: MeshOrigin("https://thetriangle.dev"), state: state,
            agentID: AgentID(agentID), handle: MailboxHandle("codex-mailbox-live"), reasonCode: "identity_verified"
        ))
        return journal
    }

    private static func expect(_ condition: @autoclosure () throws -> Bool, _ message: String) throws {
        guard try condition() else { throw ContractFailure(message) }
    }

    private static func expectAnyError<Result>(_ message: String, operation: () async throws -> Result) async throws {
        do {
            _ = try await operation()
            throw ContractFailure(message)
        } catch is ContractFailure {
            throw ContractFailure(message)
        } catch {
            return
        }
    }

    private static func expectEnrollmentError<Result>(
        _ expected: EnrollmentError,
        _ message: String,
        operation: () async throws -> Result
    ) async throws {
        do {
            _ = try await operation()
            throw ContractFailure(message)
        } catch let error as EnrollmentError {
            guard error == expected else { throw ContractFailure("\(message): wrong enrollment error") }
        } catch {
            throw ContractFailure("\(message): wrong error type")
        }
    }

    private static func expectMeshError<Result>(
        _ expected: MeshClientError,
        _ message: String,
        operation: () async throws -> Result
    ) async throws {
        do {
            _ = try await operation()
            throw ContractFailure(message)
        } catch let error as MeshClientError {
            guard error == expected else { throw ContractFailure("\(message): wrong MESH error \(error)") }
        } catch {
            throw ContractFailure("\(message): wrong error type")
        }
    }

    private static func expectReservationError<Result>(_ expected: EnrollmentReservationError, _ message: String, operation: () throws -> Result) throws {
        do { _ = try operation(); throw ContractFailure(message) }
        catch let error as EnrollmentReservationError {
            guard error == expected else { throw ContractFailure("\(message): wrong reservation error") }
        } catch { throw ContractFailure("\(message): wrong error type") }
    }

    private static func expectCredentialGateError<Result>(
        _ expected: VerifiedCredentialGateError,
        _ message: String,
        operation: () async throws -> Result
    ) async throws {
        do { _ = try await operation(); throw ContractFailure(message) }
        catch let error as VerifiedCredentialGateError {
            guard error == expected else { throw ContractFailure("\(message): wrong gate error") }
        } catch { throw ContractFailure("\(message): wrong error type") }
    }
}

private final class ScriptedTransport: MeshTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var responses: [MeshHTTPResponse]
    private var captured: [MeshHTTPRequest] = []

    init(_ responses: [MeshHTTPResponse]) { self.responses = responses }

    var requests: [MeshHTTPRequest] {
        lock.withLock { captured }
    }

    func send(_ request: MeshHTTPRequest) async throws -> MeshHTTPResponse {
        try lock.withLock {
            captured.append(request)
            guard !responses.isEmpty else { throw MeshClientError.transportUnavailable }
            return responses.removeFirst()
        }
    }
}

private final class ClosureTransport: MeshTransport, @unchecked Sendable {
    let closure: @Sendable (MeshHTTPRequest) throws -> MeshHTTPResponse
    init(_ closure: @escaping @Sendable (MeshHTTPRequest) throws -> MeshHTTPResponse) { self.closure = closure }
    func send(_ request: MeshHTTPRequest) async throws -> MeshHTTPResponse { try closure(request) }
}

private struct UnavailableTransport: MeshTransport {
    func send(_ request: MeshHTTPRequest) async throws -> MeshHTTPResponse {
        throw MeshClientError.transportUnavailable
    }
}

private final class RecordingStore: CredentialStore, @unchecked Sendable {
    private let backing = InMemoryCredentialStore()
    private(set) var didCreate = false
    func create(_ binding: CredentialBinding, for profile: ProfileName) throws {
        try backing.create(binding, for: profile)
        didCreate = true
    }
    func read(for profile: ProfileName) throws -> CredentialBinding { try backing.read(for: profile) }
    func replace(_ binding: CredentialBinding, for profile: ProfileName, confirmation: CredentialReplacementConfirmation) throws { try backing.replace(binding, for: profile, confirmation: confirmation) }
    func delete(for profile: ProfileName) throws { try backing.delete(for: profile) }
}

private final class FailingCreateStore: CredentialStore, @unchecked Sendable {
    func create(_ binding: CredentialBinding, for profile: ProfileName) throws { throw CredentialStoreError.keychainFailure }
    func read(for profile: ProfileName) throws -> CredentialBinding { throw CredentialStoreError.itemNotFound }
    func replace(_ binding: CredentialBinding, for profile: ProfileName, confirmation: CredentialReplacementConfirmation) throws { throw CredentialStoreError.keychainFailure }
    func delete(for profile: ProfileName) throws { throw CredentialStoreError.itemNotFound }
}

private final class ThrowingReadStore: CredentialStore, @unchecked Sendable {
    let error: CredentialStoreError
    init(_ error: CredentialStoreError) { self.error = error }
    func create(_ binding: CredentialBinding, for profile: ProfileName) throws { throw error }
    func read(for profile: ProfileName) throws -> CredentialBinding { throw error }
    func replace(_ binding: CredentialBinding, for profile: ProfileName, confirmation: CredentialReplacementConfirmation) throws { throw error }
    func delete(for profile: ProfileName) throws { throw error }
}

private actor BlockingEnrollmentTransport: MeshTransport {
    private var started = false
    private var released = false
    private var startWaiters: [CheckedContinuation<Void, Never>] = []
    private var releaseWaiters: [CheckedContinuation<Void, Never>] = []
    private(set) var registrationCalls = 0

    func waitUntilRegistrationStarted() async {
        if started { return }
        await withCheckedContinuation { startWaiters.append($0) }
    }

    func releaseRegistration() {
        released = true
        let waiters = releaseWaiters
        releaseWaiters.removeAll()
        for waiter in waiters { waiter.resume() }
    }

    func send(_ request: MeshHTTPRequest) async throws -> MeshHTTPResponse {
        if request.url.path.hasSuffix("/register-mailbox") {
            registrationCalls += 1
            started = true
            let waiters = startWaiters
            startWaiters.removeAll()
            for waiter in waiters { waiter.resume() }
            if !released { await withCheckedContinuation { releaseWaiters.append($0) } }
            return MeshHTTPResponse(
                statusCode: 201,
                headers: ["Content-Type": "application/json"],
                body: Data("""
                {"agent":{"id":"agent_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","handle":"codex-mailbox-live","name":"Codex Mailbox Live","description":"Remote test agent","endpointUrl":"https://thetriangle.dev/api/v1/mailbox","capabilities":["direct-messages"],"protocolVersion":"mailbox-v1","protocolBinding":"TRIANGLE","conformanceStatus":"unverified","registrationMode":"mailbox","agentCardUrl":"https://thetriangle.dev/api/v1/agents/agent_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"token":"\(EnrollmentContractCases.canary)","warning":"Save now."}
                """.utf8),
                finalURL: request.url
            )
        }
        return MeshHTTPResponse(
            statusCode: 200,
            headers: ["Content-Type": "application/json"],
            body: Data("""
            {"agent":{"id":"agent_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","name":"Codex Mailbox Live","handle":"codex-mailbox-live","registrationMode":"mailbox","endpointUrl":"https://thetriangle.dev/api/v1/mailbox"}}
            """.utf8),
            finalURL: request.url
        )
    }
}

private final class FixtureURLProtocol: URLProtocol, @unchecked Sendable {
    enum Fixture: Sendable {
        case json(status: Int, url: URL, body: Data)
        case plaintextJSON(status: Int, body: Data)
        case redirect(location: String)
        case declaredOversized(status: Int = 200)
        case streamedOversized(status: Int = 200)
    }

    private static let lock = NSLock()
    nonisolated(unsafe) private static var fixtures: [Fixture] = []
    nonisolated(unsafe) private static var captured: [URLRequest] = []
    nonisolated(unsafe) private static var redirected: [URLRequest] = []

    static var requests: [URLRequest] { lock.withLock { captured } }
    static var redirectTargets: [URLRequest] { lock.withLock { redirected } }

    static func reset(_ newFixtures: [Fixture]) {
        lock.withLock {
            fixtures = newFixtures
            captured = []
            redirected = []
        }
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let fixture: Fixture? = Self.lock.withLock {
            Self.captured.append(request)
            return Self.fixtures.isEmpty ? nil : Self.fixtures.removeFirst()
        }
        guard let fixture else {
            client?.urlProtocol(self, didFailWithError: URLError(.resourceUnavailable))
            return
        }
        switch fixture {
        case let .json(status, url, body):
            respond(status: status, url: url, headers: ["Content-Type": "application/json"], chunks: [body])
        case let .plaintextJSON(status, body):
            respond(status: status, url: request.url!, headers: ["Content-Type": "text/plain"], chunks: [body])
        case let .redirect(location):
            let response = HTTPURLResponse(
                url: request.url!, statusCode: 302, httpVersion: "HTTP/1.1",
                headerFields: ["Location": location, "Content-Type": "application/json"]
            )!
            var redirectedRequest = request
            redirectedRequest.url = URL(string: location)!
            Self.lock.withLock { Self.redirected.append(redirectedRequest) }
            client?.urlProtocol(self, wasRedirectedTo: redirectedRequest, redirectResponse: response)
            client?.urlProtocolDidFinishLoading(self)
        case let .declaredOversized(status):
            respond(
                status: status,
                url: request.url!,
                headers: ["Content-Type": "application/json", "Content-Length": String(MeshClient.maximumResponseBytes + 1)],
                chunks: []
            )
        case let .streamedOversized(status):
            respond(
                status: status,
                url: request.url!,
                headers: ["Content-Type": "application/json"],
                chunks: [Data(repeating: 0x20, count: MeshClient.maximumResponseBytes), Data([0x20])]
            )
        }
    }

    override func stopLoading() {}

    private func respond(status: Int, url: URL, headers: [String: String], chunks: [Data]) {
        let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        for chunk in chunks { client?.urlProtocol(self, didLoad: chunk) }
        client?.urlProtocolDidFinishLoading(self)
    }
}
