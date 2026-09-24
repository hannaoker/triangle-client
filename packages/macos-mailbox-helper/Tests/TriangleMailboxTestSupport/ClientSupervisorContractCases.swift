import Darwin
import CryptoKit
import Foundation
@_spi(EnrollmentTesting) @_spi(ClientInstanceTesting) import TriangleMailboxCore

public enum ClientSupervisorContractCases {
    public struct ContractCase: Sendable {
        public let name: String
        public let run: @Sendable () async throws -> Void
    }

    public static let all: [ContractCase] = [
        .init(name: "supervisor pairs each profile with its exact verified identity", run: exactPairing),
        .init(name: "durable ten-agent lifecycle drives exact coordinator bootstraps", run: durableTenAgentLifecycle),
        .init(name: "supervisor preflight proves eligibility without launching", run: eligibilityPreflight),
        .init(name: "all runtime paths resolve before any credential is read", run: resolveBeforeCredential),
        .init(name: "coordinator failure occurs before any credential is read", run: coordinatorFailureBeforeCredential),
        .init(name: "one ineligible profile is omitted without stopping eligible profiles", run: badProfileIsolation),
        .init(name: "no eligible profile fails with a bounded diagnostic", run: noEligibleProfile),
        .init(name: "bootstrap is bounded and reaches the child only through stdin", run: boundedAnonymousBootstrap),
        .init(name: "coordinator launch has credential-free argv and environment", run: cleanCoordinatorLaunch),
        .init(name: "coordinator receives only the single-digit production pool opt-in", run: productionOptInReachesCoordinator),
        .init(name: "prepared launch diagnostics never describe credentials", run: redactedDiagnostics),
        .init(name: "host waits for coordinator shutdown and rejects failure", run: shutdownLifecycle),
        .init(name: "early child exit cannot terminate the Swift host with SIGPIPE", run: subprocessEarlyExitIsContained),
        .init(name: "stdin backpressure times out and reaps the child", run: subprocessBackpressureTimesOutAndReaps),
        .init(name: "input failure kills and reaps a child that ignores TERM", run: subprocessIgnoredTerminationIsKilled),
        .init(name: "signal dispositions are preserved and concurrent runs serialize", run: signalPreservationAndSerialization),
        .init(name: "coordinator readiness acknowledgement writes only a fresh private marker", run: readinessMarkerContract),
        .init(name: "mcp-interactive delivery mode is omitted from coordinator bootstrap", run: mcpInteractiveDeliveryOmitted),
        .init(name: "event-driven profiles launch via eventWake bootstrap not worker instances", run: eventDrivenWakeBootstrap),
        .init(name: "mcp-interactive stays excluded from eventWake membership", run: mcpInteractiveExcludedFromEventWake),
        .init(name: "mcp-interactive emits appServerWake when binding present", run: mcpInteractiveAppServerWakeBootstrap),
        .init(name: "mcp-interactive without binding stays omitted", run: mcpInteractiveAppServerBindingMissing),
        .init(name: "grok-bot emits grokBotWake when binding present", run: grokBotWakeBootstrap),
        .init(name: "grok-bot without binding stays omitted", run: grokBotBindingMissing),
        .init(name: "headless-app-server emits sorted headlessWakes for every Codex profile", run: headlessWakeBootstrap),
        .init(name: "cursor-acp emits cursorAcpWakes for shadow test profile", run: cursorAcpWakeBootstrap),
        .init(name: "cursor-acp stays out of Codex headless pool beside grok-bot", run: cursorAcpWakeIsolatedFromCodexAndGrok),
        .init(name: "headless-app-server records every missing v2 binding entry", run: headlessWakeBindingEntryMissing),
        .init(name: "headless-app-server rejects duplicate v2 instance IDs", run: headlessWakeDuplicateInstanceRejected),
        .init(name: "headless-app-server rejects shared mailbox identities", run: headlessWakeSharedCredentialRejected),
        .init(name: "headless-app-server rejects aliased and traversing state roots", run: headlessWakeStateRootAliasesRejected),
        .init(name: "headless-app-server rejects fractional poll intervals", run: headlessWakeFractionalPollIntervalRejected),
        .init(name: "headless-app-server isolates one invalid credential", run: headlessWakeInvalidCredential),
        .init(name: "headless-app-server without binding stays omitted", run: headlessWakeBindingMissing),
        .init(name: "loaded dedicated drain LaunchAgent omits supervisor headlessWake", run: dedicatedHeadlessDrainOmitsSupervisorClaimer),
        .init(name: "headlessWake keys conversations without a global room pin", run: headlessWakeNoGlobalRoomPin),
        .init(name: "grok-bot never joins headless Codex wake", run: grokBotExcludedFromHeadlessWake),
        .init(name: "invalid durable installation identity fails closed", run: invalidInstallationIdentityFailsClosed),
        .init(name: "concurrent durable installation identity resolution is stable", run: concurrentInstallationIdentityResolutionIsStable),
    ]

    public static func invalidInstallationIdentityFailsClosed() async throws {
        let root = FileManager.default.temporaryDirectory
            .resolvingSymlinksInPath()
            .appendingPathComponent("triangle-installation-identity-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        let record = root.appendingPathComponent("installation.json")
        try Data("{\"version\":1,\"installationId\":\"invalid\"}".utf8).write(to: record)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: record.path)
        let store = FileClientInstallationIdentityStore(testRoot: root)
        var rejected = false
        do {
            _ = try store.resolve()
        } catch ClientInstallationIdentityError.invalidRecord {
            rejected = true
        }
        try expect(rejected, "invalid installation identity was silently replaced")
    }

    public static func concurrentInstallationIdentityResolutionIsStable() async throws {
        let root = FileManager.default.temporaryDirectory
            .resolvingSymlinksInPath()
            .appendingPathComponent("triangle-installation-concurrent-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        let first = FileClientInstallationIdentityStore(testRoot: root)
        let second = FileClientInstallationIdentityStore(testRoot: root)
        async let firstID = Task.detached { try first.resolve() }.value
        async let secondID = Task.detached { try second.resolve() }.value
        let resolved = try await [firstID, secondID]
        try expect(Set(resolved).count == 1, "concurrent installation identity resolution split the durable id")
        let reread = try first.resolve()
        try expect(reread == resolved[0], "durable installation identity changed after concurrent resolution")
    }

    fileprivate static let origin = "https://thetriangle.dev"

    public static func exactPairing() async throws {
        let fixture = try SupervisorFixture(specifications: [
            .init(profile: "alpha-codex", adapter: .codex, digit: "1"),
            .init(profile: "beta-codex", adapter: .codex, digit: "2"),
            .init(profile: "gamma-hermes", adapter: .hermes, digit: "3"),
        ])
        let launch = try await fixture.supervisor.prepareEnabledInstances()
        try expect(launch.instances.count == 3, "enabled instances were lost")
        try expect(Set(launch.instances.map(\.instanceID)).count == 3, "instance identities collided")
        try await fixture.supervisor.run()

        let bootstrap = try fixture.process.decodedBootstrap()
        try expect(bootstrap.version == 1, "bootstrap version changed")
        try expect(bootstrap.maxConcurrentReasoners == 2, "global reasoning budget changed")
        try expect(bootstrap.instances.count == 3, "bootstrap instance count changed")
        for specification in fixture.specifications {
            let identifier = ClientInstanceID.derive(profile: specification.profile).value
            let instance = try require(bootstrap.instances.first { $0.instanceId == identifier }, "instance missing from bootstrap")
            try expect(instance.mailbox.meshUrl == origin, "origin crossed profiles")
            try expect(instance.mailbox.meshToken == specification.token, "token crossed profiles")
            try expect(instance.mailbox.recipientId == specification.agentID.value, "agent ID crossed profiles")
            try expect(instance.mailbox.pageLimit == 1, "mailbox page limit changed")
            try expect(instance.runnerEnvironment["TRIANGLE_INSTANCE_ID"] == identifier, "runner instance binding changed")
            let activeHome = specification.adapter == .codex ? "CODEX_HOME" : "HERMES_HOME"
            let inactiveHome = specification.adapter == .codex ? "HERMES_HOME" : "CODEX_HOME"
            try expect(instance.runnerEnvironment[activeHome]?.contains(identifier) == true, "active model home was not isolated")
            try expect(instance.runnerEnvironment[inactiveHome] == nil, "inactive runtime environment leaked")
        }
    }

    public static func durableTenAgentLifecycle() async throws {
        let root = FileManager.default.temporaryDirectory
            .resolvingSymlinksInPath()
            .appendingPathComponent("triangle-client-lifecycle-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let instanceStore = FileClientInstanceStore(testRoot: root)
        let digits: [Character] = Array("123456789a")
        let specifications = try digits.enumerated().map { index, digit in
            try InstanceSpecification(
                profile: index < 6 ? "codex-\(index + 1)" : "hermes-\(index + 1)",
                adapter: index < 6 ? .codex : .hermes,
                digit: digit
            )
        }
        let journal = InMemoryEnrollmentJournal()
        var bindings: [ProfileName: CredentialBinding] = [:]
        var identities: [String: IdentityResult] = [:]
        for specification in specifications {
            try instanceStore.create(ClientInstance(
                profile: specification.profile,
                runtimeAdapter: specification.adapter,
                deliveryMode: .worker
            ))
            let binding = CredentialBinding(
                origin: try MeshOrigin(origin),
                agentID: specification.agentID,
                handle: specification.handle,
                token: try MeshToken(specification.token)
            )
            bindings[specification.profile] = binding
            identities[specification.token] = .identity(id: specification.agentID, handle: specification.handle)
            try journal.write(.testing(
                profile: specification.profile,
                origin: binding.origin,
                state: .verified,
                agentID: binding.agentID,
                handle: binding.handle,
                reasonCode: "identity_verified"
            ))
        }
        let gate = VerifiedCredentialGate(
            store: RecordingMultiCredentialStore(bindings: bindings, events: EventLog()),
            transport: MultiIdentityTransport(results: identities),
            reservation: InMemoryEnrollmentReservation(),
            journal: journal
        )
        let resolver = RecordingSupervisorResolver(events: EventLog(), failureAt: nil, coordinatorFails: false)
        let process = RecordingSupervisorProcess()
        func makeSupervisor(_ store: any ClientInstanceStore) -> ClientSupervisor {
            ClientSupervisor(instanceStore: store, gate: gate, resolver: resolver, processRunner: process, parentEnvironment: [:])
        }

        var supervisor = makeSupervisor(instanceStore)
        try await supervisor.run()
        var launch = try process.decodedBootstrap()
        try expect(launch.instances.count == 10, "initial coordinator bootstrap did not contain ten durable instances")
        try expect(launch.instances.filter { $0.runnerEnvironment["CODEX_HOME"] != nil }.count == 6, "initial Codex bootstrap count changed")
        try expect(launch.instances.filter { $0.runnerEnvironment["HERMES_HOME"] != nil }.count == 4, "initial Hermes bootstrap count changed")

        try instanceStore.setEnabled(false, profile: specifications[5].profile)
        let restartedStore = FileClientInstanceStore(testRoot: root)
        supervisor = makeSupervisor(restartedStore)
        try await supervisor.run()
        launch = try process.decodedBootstrap()
        try expect(launch.instances.count == 9, "disabled instance remained in restarted coordinator bootstrap")
        try expect(!launch.instances.contains { $0.instanceId == ClientInstanceID.derive(profile: specifications[5].profile).value }, "wrong disabled profile was selected")

        try restartedStore.setEnabled(true, profile: specifications[5].profile)
        try await supervisor.run()
        launch = try process.decodedBootstrap()
        try expect(launch.instances.count == 10, "enabled instance did not return to coordinator bootstrap")

        try restartedStore.remove(profile: specifications[8].profile)
        try await supervisor.run()
        launch = try process.decodedBootstrap()
        try expect(launch.instances.count == 9, "removed instance remained in coordinator bootstrap")
        try expect(!launch.instances.contains { $0.instanceId == ClientInstanceID.derive(profile: specifications[8].profile).value }, "wrong removed profile was selected")
        try expect(process.invocationCount == 4, "lifecycle transitions did not traverse the coordinator process-control seam")
        let records = try FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: [.isRegularFileKey])
            .filter { try $0.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile == true }
            .map { try Data(contentsOf: $0) }
        for specification in specifications {
            let secret = Data(specification.token.utf8)
            try expect(records.allSatisfy { $0.range(of: secret) == nil }, "credential reached the durable instance registry")
        }
    }

    public static func eligibilityPreflight() async throws {
        let fixture = try SupervisorFixture(specifications: [
            .init(profile: "preflight-codex", adapter: .codex, digit: "9"),
        ])
        try await fixture.supervisor.preflight()
        try expect(fixture.process.request == nil, "preflight launched the coordinator")
        try expect(fixture.credentials.readCount == 1, "preflight did not verify the exact credential")
    }

    public static func resolveBeforeCredential() async throws {
        let events = EventLog()
        let fixture = try SupervisorFixture(
            specifications: [
                .init(profile: "first", adapter: .codex, digit: "4"),
                .init(profile: "second", adapter: .hermes, digit: "5"),
                .init(profile: "third", adapter: .codex, digit: "f"),
            ],
            events: events,
            resolverFailureAt: 1
        )
        let launch = try await fixture.supervisor.prepareEnabledInstances()
        try expect(launch.instances.count == 2, "one corrupt runtime stopped valid profiles")
        try expect(launch.omitted.contains { $0.reasonCode == "runtime_ineligible" }, "corrupt runtime omission was not bounded")
        let values = events.values
        try expect(Array(values.prefix(4)) == ["resolve:first", "resolve:second", "resolve:third", "resolve:coordinator"], "credential was read before every runtime attempt and coordinator resolution: \(values)")
        try expect(fixture.credentials.readCount == 2, "valid profiles were not verified exactly once")
    }

    public static func coordinatorFailureBeforeCredential() async throws {
        let events = EventLog()
        let fixture = try SupervisorFixture(
            specifications: [
                .init(profile: "coordinator-one", adapter: .codex, digit: "1"),
                .init(profile: "coordinator-two", adapter: .hermes, digit: "2"),
            ],
            events: events,
            coordinatorFails: true
        )
        do {
            _ = try await fixture.supervisor.prepareEnabledInstances()
            throw SupervisorContractFailure("missing v4 coordinator was accepted")
        } catch let error as ClientSupervisorError {
            try expect(error == .runtimeUnavailable, "coordinator failure was not sanitized")
        }
        try expect(events.values == ["resolve:coordinator-one", "resolve:coordinator-two", "resolve:coordinator"], "coordinator failure ordering changed")
        try expect(fixture.credentials.readCount == 0, "credential was read before coordinator validation")
    }

    public static func badProfileIsolation() async throws {
        let fixture = try SupervisorFixture(
            specifications: [
                .init(profile: "good-codex", adapter: .codex, digit: "6"),
                .init(profile: "bad-hermes", adapter: .hermes, digit: "7", verificationFails: true),
                .init(profile: "good-hermes", adapter: .hermes, digit: "8"),
            ]
        )
        let launch = try await fixture.supervisor.prepareEnabledInstances()
        try expect(launch.instances.count == 2, "bad profile stopped eligible profiles")
        try expect(launch.omitted.count == 1, "bad profile omission was not recorded")
        try expect(launch.omitted[0].reasonCode == "credential_ineligible", "omission diagnostic was not bounded")
        try expect(!String(describing: launch.omitted[0]).contains(fixture.specifications[1].token), "omission diagnostic exposed token")
        let quarantined = try fixture.journal.read(for: fixture.specifications[1].profile)
        try expect(quarantined?.state == .quarantined, "failed identity was not quarantined independently")
        try await fixture.supervisor.run()
        let bootstrap = try fixture.process.decodedBootstrap()
        try expect(!bootstrap.instances.contains { $0.mailbox.meshToken == fixture.specifications[1].token }, "ineligible token reached bootstrap")
    }

    public static func mcpInteractiveDeliveryOmitted() async throws {
        let fixture = try SupervisorFixture(specifications: [
            .init(profile: "worker-codex", adapter: .codex, digit: "1"),
            .init(profile: "interactive-hermes", adapter: .hermes, digit: "2"),
        ])
        try fixture.instanceStore.setDeliveryMode(.mcpInteractive, profile: fixture.specifications[1].profile)
        let launch = try await fixture.supervisor.prepareEnabledInstances()
        try expect(launch.instances.count == 1, "mcp-interactive profile was not omitted from bootstrap")
        try expect(launch.instances[0].instanceID == ClientInstanceID.derive(profile: fixture.specifications[0].profile).value, "wrong profile remained in bootstrap")
        try expect(launch.omitted.contains { $0.reasonCode == "delivery_mode_mcp_interactive" }, "mcp-interactive omission was not recorded")
        try await fixture.supervisor.run()
        let bootstrap = try fixture.process.decodedBootstrap()
        try expect(bootstrap.instances.count == 1, "mcp-interactive profile reached coordinator bootstrap")
        try expect(!bootstrap.instances.contains { $0.instanceId == ClientInstanceID.derive(profile: fixture.specifications[1].profile).value }, "interactive profile leaked into bootstrap")
    }

    public static func eventDrivenWakeBootstrap() async throws {
        let fixture = try SupervisorFixture(specifications: [
            .init(profile: "worker-codex", adapter: .codex, digit: "1"),
            .init(profile: "event-hermes", adapter: .hermes, digit: "2"),
        ])
        try fixture.instanceStore.setDeliveryMode(.eventDriven, profile: fixture.specifications[1].profile)
        let launch = try await fixture.supervisor.prepareEnabledInstances()
        try expect(launch.instances.count == 1, "event-driven profile was not kept out of worker instances")
        try expect(launch.instances[0].instanceID == ClientInstanceID.derive(profile: fixture.specifications[0].profile).value, "wrong profile remained in worker instances")
        try expect(launch.eventWakeProfileCount == 1, "event-driven wake profile was not prepared")
        try expect(!launch.omitted.contains { $0.reasonCode == "delivery_mode_event_driven" }, "event-driven profile was treated as omitted instead of wake-owned")
        let eventDrivenInstance = try fixture.instanceStore.read(profile: fixture.specifications[1].profile)
        try expect(eventDrivenInstance.participatesInEventDrivenWake, "event-driven ownership flag was not set")
        try await fixture.supervisor.run()
        let bootstrap = try fixture.process.decodedBootstrap()
        try expect(bootstrap.instances.count == 1, "event-driven profile leaked into worker bootstrap instances")
        try expect(!bootstrap.instances.contains { $0.instanceId == ClientInstanceID.derive(profile: fixture.specifications[1].profile).value }, "event-driven profile leaked into worker bootstrap")
        let eventWake = try require(bootstrap.eventWake, "eventWake bootstrap section missing")
        try expect(eventWake.profiles.count == 1, "eventWake profile count changed")
        try expect(eventWake.profiles[0].instanceId == ClientInstanceID.derive(profile: fixture.specifications[1].profile).value, "wrong wake profile selected")
        try expect(eventWake.profiles[0].agentId == fixture.specifications[1].agentID.value, "wake agent id crossed profiles")
        try expect(eventWake.actorProfile == fixture.specifications[1].profile.value, "wake actor profile incorrect")
        try expect(eventWake.ensureBeforeWatch == true, "watch-ensure preflight was not requested")
        try expect(eventWake.helperPath.hasSuffix("/triangle-mailbox"), "helper path missing from eventWake")
        try expect(eventWake.cursorPath.hasSuffix("/wake-cursor.json"), "cursor path missing from eventWake")
        try expect(eventWake.installationId.hasPrefix("inst_"), "installation id missing from eventWake")
        try expect(eventWake.drains.count == 1, "eventWake drain count changed")
        try expect(eventWake.drains[0].instanceId == eventWake.profiles[0].instanceId, "drain instance crossed profiles")
        try expect(eventWake.drains[0].mailbox.recipientId == fixture.specifications[1].agentID.value, "drain recipient crossed profiles")
        try expect(eventWake.drains[0].mailbox.meshToken == fixture.specifications[1].token, "drain mailbox token missing")
        try expect(eventWake.drains[0].runner.args[0].hasSuffix("/hermes-runner.mjs"), "drain runner adapter crossed profiles")
        try expect(!bootstrap.instances.contains { $0.mailbox.meshToken == fixture.specifications[1].token }, "event-driven token leaked into worker instances")
        let encoded = try require(fixture.process.standardInput, "bootstrap missing")
        let raw = String(decoding: encoded, as: UTF8.self)
        try expect(!raw.contains("mesh_watch_"), "watch credential leaked into bootstrap")
        try expect(raw.contains(fixture.specifications[1].token), "event-driven mailbox token missing from drain bootstrap")
    }

    public static func mcpInteractiveExcludedFromEventWake() async throws {
        let fixture = try SupervisorFixture(specifications: [
            .init(profile: "worker-codex", adapter: .codex, digit: "1"),
            .init(profile: "event-hermes", adapter: .hermes, digit: "2"),
            .init(profile: "interactive-codex", adapter: .codex, digit: "3"),
        ])
        try fixture.instanceStore.setDeliveryMode(.eventDriven, profile: fixture.specifications[1].profile)
        try fixture.instanceStore.setDeliveryMode(.mcpInteractive, profile: fixture.specifications[2].profile)
        let launch = try await fixture.supervisor.prepareEnabledInstances()
        try expect(launch.eventWakeProfileCount == 1, "interactive profile entered eventWake")
        try expect(launch.omitted.contains { $0.reasonCode == "delivery_mode_mcp_interactive" }, "mcp-interactive omission was not recorded")
        try await fixture.supervisor.run()
        let bootstrap = try fixture.process.decodedBootstrap()
        let eventWake = try require(bootstrap.eventWake, "eventWake missing")
        let interactiveID = ClientInstanceID.derive(profile: fixture.specifications[2].profile).value
        try expect(!eventWake.profiles.contains { $0.instanceId == interactiveID }, "mcp-interactive leaked into eventWake profiles")
        try expect(!eventWake.drains.contains { $0.instanceId == interactiveID }, "mcp-interactive leaked into eventWake drains")
        try expect(!bootstrap.instances.contains { $0.instanceId == interactiveID }, "mcp-interactive leaked into worker instances")
        try expect(bootstrap.appServerWake == nil, "appServerWake emitted without binding")
    }

    public static func mcpInteractiveAppServerWakeBootstrap() async throws {
        let fixture = try SupervisorFixture(
            specifications: [
                .init(profile: "worker-codex", adapter: .codex, digit: "1"),
                .init(profile: "interactive-codex", adapter: .codex, digit: "3"),
            ],
            provisionAppServerBinding: true
        )
        try fixture.instanceStore.setDeliveryMode(.mcpInteractive, profile: fixture.specifications[1].profile)
        try await fixture.supervisor.run()
        let bootstrap = try fixture.process.decodedBootstrap()
        let interactive = fixture.specifications[1]
        let interactiveID = ClientInstanceID.derive(profile: interactive.profile).value
        let appServerWake = try require(bootstrap.appServerWake, "appServerWake missing")
        try expect(appServerWake.actorProfile == interactive.profile.value, "wrong appServerWake actor")
        try expect(appServerWake.binding.instanceId == interactiveID, "binding instance mismatch")
        try expect(appServerWake.binding.agentId == interactive.agentID.value, "binding agent mismatch")
        try expect(appServerWake.ensureBeforeWatch == true, "ensureBeforeWatch should be true")
        try expect(appServerWake.authTokenFile != nil, "authTokenFile missing")
        try expect(appServerWake.authTokenEnv == nil, "authTokenEnv should be null")
        try expect(!bootstrap.instances.contains { $0.instanceId == interactiveID }, "interactive leaked into workers")
        let encoded = try require(fixture.process.standardInput, "bootstrap missing")
        let raw = String(decoding: encoded, as: UTF8.self)
        try expect(!raw.contains("mesh_watch_"), "watch credential leaked into bootstrap")
        try expect(!raw.contains(interactive.token), "interactive mailbox token leaked into appServerWake")
    }

    public static func mcpInteractiveAppServerBindingMissing() async throws {
        let fixture = try SupervisorFixture(specifications: [
            .init(profile: "worker-codex", adapter: .codex, digit: "1"),
            .init(profile: "interactive-codex", adapter: .codex, digit: "3"),
        ])
        try fixture.instanceStore.setDeliveryMode(.mcpInteractive, profile: fixture.specifications[1].profile)
        let launch = try await fixture.supervisor.prepareEnabledInstances()
        let interactiveID = ClientInstanceID.derive(profile: fixture.specifications[1].profile).value
        try expect(launch.omitted.contains {
            $0.instanceID == interactiveID && $0.reasonCode == "app_server_binding_missing"
        }, "missing binding was not recorded")
        try await fixture.supervisor.run()
        let bootstrap = try fixture.process.decodedBootstrap()
        try expect(bootstrap.appServerWake == nil, "appServerWake emitted without binding file")
    }

    public static func grokBotWakeBootstrap() async throws {
        let fixture = try SupervisorFixture(
            specifications: [
                .init(profile: "worker-codex", adapter: .codex, digit: "1"),
                .init(profile: "bob-grok", adapter: .grokBot, digit: "7"),
            ],
            provisionGrokBotBinding: true
        )
        try fixture.instanceStore.setDeliveryMode(.grokBot, profile: fixture.specifications[1].profile)
        try await fixture.supervisor.run()
        let bootstrap = try fixture.process.decodedBootstrap()
        try expect(bootstrap.instances.count == 1, "worker count wrong with grokBotWake")
        try expect(bootstrap.grokBotWake != nil, "grokBotWake missing")
        let grokBotWake = try require(bootstrap.grokBotWake, "grokBotWake missing")
        let bob = fixture.specifications[1]
        let bobID = ClientInstanceID.derive(profile: bob.profile).value
        try expect(grokBotWake.actorProfile == bob.profile.value, "wrong grokBotWake actor")
        try expect(grokBotWake.binding.instanceId == bobID, "binding instance mismatch")
        try expect(grokBotWake.binding.agentId == bob.agentID.value, "binding agent mismatch")
        try expect(grokBotWake.binding.profile == bob.profile.value, "binding profile mismatch")
        try expect(grokBotWake.binding.wakeMode == "webhook", "wakeMode should be webhook")
        try expect(grokBotWake.ensureBeforeWatch == true, "ensureBeforeWatch should be true")
        try expect(grokBotWake.webhookUrlPath.hasSuffix("grok-bot-webhook.url"), "webhook url path wrong")
        try expect(grokBotWake.webhookKeyPath.hasSuffix("grok-bot-webhook.key"), "webhook key path wrong")
        let encoded = try require(fixture.process.standardInput, "bootstrap missing")
        let raw = String(decoding: encoded, as: UTF8.self)
        try expect(!raw.contains(bob.token), "bob mailbox token leaked into grokBotWake")
        try expect(!raw.contains("webhook-secret-key"), "webhook key leaked into bootstrap")
    }

    public static func grokBotBindingMissing() async throws {
        let fixture = try SupervisorFixture(specifications: [
            .init(profile: "worker-codex", adapter: .codex, digit: "1"),
            .init(profile: "bob-grok", adapter: .grokBot, digit: "7"),
        ])
        try fixture.instanceStore.setDeliveryMode(.grokBot, profile: fixture.specifications[1].profile)
        let launch = try await fixture.supervisor.prepareEnabledInstances()
        let bobID = ClientInstanceID.derive(profile: fixture.specifications[1].profile).value
        try expect(launch.omitted.contains {
            $0.instanceID == bobID && $0.reasonCode == "grok_bot_binding_missing"
        }, "missing grok-bot binding was not recorded")
        try await fixture.supervisor.run()
        let bootstrap = try fixture.process.decodedBootstrap()
        try expect(bootstrap.grokBotWake == nil, "grokBotWake emitted without binding file")
    }

    public static func headlessWakeBootstrap() async throws {
        let fixture = try SupervisorFixture(
            specifications: [
                .init(profile: "worker-codex", adapter: .codex, digit: "1"),
                .init(profile: "codex-bob-test", adapter: .codex, digit: "b"),
                .init(profile: "codex-headless", adapter: .codex, digit: "c"),
            ],
            provisionHeadlessRuntimeBinding: true,
            headlessBindingProfiles: ["codex-headless", "codex-bob-test"]
        )
        try fixture.instanceStore.setDeliveryMode(.headlessAppServer, profile: fixture.specifications[1].profile)
        try fixture.instanceStore.setDeliveryMode(.headlessAppServer, profile: fixture.specifications[2].profile)
        try await fixture.supervisor.run()
        let bootstrap = try fixture.process.decodedBootstrap()
        try expect(bootstrap.instances.count == 1, "worker count wrong with headlessWakes")
        let wakes = bootstrap.headlessWakes
        try expect(wakes.map(\.profile) == ["codex-bob-test", "codex-headless"], "headless wakes are not sorted")
        try expect(Set(wakes.map(\.profileInstanceId)).count == 2, "headless instance IDs collided")
        try expect(Set(wakes.map(\.stateRoot)).count == 2, "headless state roots collided")
        try expect(wakes.allSatisfy { $0.allowedRoomId == nil }, "global room pin reached v2 headless wake")
        let headlessIds = Set(wakes.map(\.profileInstanceId))
        try expect(!bootstrap.instances.contains { headlessIds.contains($0.instanceId) }, "headless leaked into worker instances")
        let encoded = try require(fixture.process.standardInput, "bootstrap missing")
        let raw = String(decoding: encoded, as: UTF8.self)
        try expect(!raw.contains(fixture.specifications[1].token), "first headless mailbox token leaked")
        try expect(!raw.contains(fixture.specifications[2].token), "second headless mailbox token leaked")
        try expect(!raw.contains("headlessWake\""), "legacy singleton headlessWake was emitted")
    }

    public static func headlessWakeBindingEntryMissing() async throws {
        let fixture = try SupervisorFixture(
            specifications: [
                .init(profile: "worker-codex", adapter: .codex, digit: "1"),
                .init(profile: "codex-bob-test", adapter: .codex, digit: "b"),
                .init(profile: "codex-headless", adapter: .codex, digit: "c"),
            ],
            provisionHeadlessRuntimeBinding: true,
            headlessBindingProfiles: ["codex-headless"]
        )
        for specification in fixture.specifications.dropFirst() {
            try fixture.instanceStore.setDeliveryMode(.headlessAppServer, profile: specification.profile)
        }
        let launch = try await fixture.supervisor.prepareEnabledInstances()
        let missingID = ClientInstanceID.derive(profile: fixture.specifications[1].profile).value
        try expect(launch.omitted.contains { $0.instanceID == missingID && $0.reasonCode == "headless_runtime_binding_mismatch" }, "missing v2 entry was not explicit")
        try await fixture.supervisor.run()
        let bootstrap = try fixture.process.decodedBootstrap()
        try expect(bootstrap.headlessWakes.map(\.profile) == ["codex-headless"], "valid v2 entry was lost")
    }

    public static func headlessWakeDuplicateInstanceRejected() async throws {
        let fixture = try SupervisorFixture(
            specifications: [
                .init(profile: "codex-bob-test", adapter: .codex, digit: "b"),
                .init(profile: "codex-headless", adapter: .codex, digit: "c"),
            ],
            provisionHeadlessRuntimeBinding: true,
            headlessBindingProfiles: ["codex-bob-test", "codex-headless"],
            duplicateHeadlessInstanceID: true
        )
        for specification in fixture.specifications {
            try fixture.instanceStore.setDeliveryMode(.headlessAppServer, profile: specification.profile)
        }
        do {
            _ = try await fixture.supervisor.prepareEnabledInstances()
            throw SupervisorContractFailure("duplicate headless instance ID was accepted")
        } catch let error as ClientSupervisorError {
            try expect(error == .invalidBootstrap, "duplicate instance ID did not fail closed")
        }
    }

    public static func headlessWakeSharedCredentialRejected() async throws {
        let fixture = try SupervisorFixture(
            specifications: [
                .init(profile: "codex-bob-test", adapter: .codex, digit: "c"),
                .init(profile: "codex-headless", adapter: .codex, digit: "c"),
            ],
            provisionHeadlessRuntimeBinding: true,
            headlessBindingProfiles: ["codex-bob-test", "codex-headless"]
        )
        for specification in fixture.specifications {
            try fixture.instanceStore.setDeliveryMode(.headlessAppServer, profile: specification.profile)
        }
        do {
            _ = try await fixture.supervisor.prepareEnabledInstances()
            throw SupervisorContractFailure("shared headless mailbox identity was accepted")
        } catch let error as ClientSupervisorError {
            try expect(error == .invalidBootstrap, "shared mailbox identity did not fail closed")
            try expect(!String(reflecting: error).contains(fixture.specifications[0].token), "shared credential leaked through error")
        }
    }

    public static func headlessWakeStateRootAliasesRejected() async throws {
        for stateRoots in [
            ["codex-bob-test": "/private/headless-state/a", "codex-headless": "/private/headless-state/./a"],
            ["codex-bob-test": "/private/headless-state/a", "codex-headless": "/private/headless-state/b/../a"],
        ] {
            let fixture = try SupervisorFixture(
                specifications: [
                    .init(profile: "codex-bob-test", adapter: .codex, digit: "b"),
                    .init(profile: "codex-headless", adapter: .codex, digit: "c"),
                ],
                provisionHeadlessRuntimeBinding: true,
                headlessBindingProfiles: ["codex-bob-test", "codex-headless"],
                headlessStateRoots: stateRoots
            )
            for specification in fixture.specifications {
                try fixture.instanceStore.setDeliveryMode(.headlessAppServer, profile: specification.profile)
            }
            do {
                _ = try await fixture.supervisor.prepareEnabledInstances()
                throw SupervisorContractFailure("aliased or traversing state roots were accepted")
            } catch let error as ClientSupervisorError {
                try expect(error == .invalidBootstrap, "state-root alias did not fail closed")
            }
        }

        let aliasRoot = FileManager.default.temporaryDirectory
            .resolvingSymlinksInPath()
            .appendingPathComponent("triangle-headless-state-alias-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: aliasRoot) }
        let realRoot = aliasRoot.appendingPathComponent("real", isDirectory: true)
        let linkedRoot = aliasRoot.appendingPathComponent("linked", isDirectory: true)
        try FileManager.default.createDirectory(at: realRoot, withIntermediateDirectories: true)
        try FileManager.default.createSymbolicLink(at: linkedRoot, withDestinationURL: realRoot)
        let fixture = try SupervisorFixture(
            specifications: [
                .init(profile: "codex-bob-test", adapter: .codex, digit: "b"),
                .init(profile: "codex-headless", adapter: .codex, digit: "c"),
            ],
            provisionHeadlessRuntimeBinding: true,
            headlessBindingProfiles: ["codex-bob-test", "codex-headless"],
            headlessStateRoots: [
                "codex-bob-test": realRoot.appendingPathComponent("bob").path,
                "codex-headless": linkedRoot.appendingPathComponent("headless").path,
            ]
        )
        for specification in fixture.specifications {
            try fixture.instanceStore.setDeliveryMode(.headlessAppServer, profile: specification.profile)
        }
        do {
            _ = try await fixture.supervisor.prepareEnabledInstances()
            throw SupervisorContractFailure("symlinked state root was accepted")
        } catch let error as ClientSupervisorError {
            try expect(error == .invalidBootstrap, "symlinked state root did not fail closed")
        }
    }

    public static func headlessWakeFractionalPollIntervalRejected() async throws {
        let fixture = try SupervisorFixture(
            specifications: [.init(profile: "codex-headless", adapter: .codex, digit: "c")],
            provisionHeadlessRuntimeBinding: true,
            headlessBindingProfiles: ["codex-headless"],
            headlessPollIntervalMs: 1_000.5
        )
        try fixture.instanceStore.setDeliveryMode(.headlessAppServer, profile: fixture.specifications[0].profile)
        do {
            _ = try await fixture.supervisor.prepareEnabledInstances()
            throw SupervisorContractFailure("fractional poll interval was accepted")
        } catch let error as ClientSupervisorError {
            try expect(error == .invalidBootstrap, "fractional poll interval did not fail closed")
        }
    }

    public static func headlessWakeInvalidCredential() async throws {
        let fixture = try SupervisorFixture(
            specifications: [
                .init(profile: "worker-codex", adapter: .codex, digit: "1"),
                .init(profile: "codex-bob-test", adapter: .codex, digit: "b", verificationFails: true),
                .init(profile: "codex-headless", adapter: .codex, digit: "c"),
            ],
            provisionHeadlessRuntimeBinding: true,
            headlessBindingProfiles: ["codex-bob-test", "codex-headless"]
        )
        for specification in fixture.specifications.dropFirst() {
            try fixture.instanceStore.setDeliveryMode(.headlessAppServer, profile: specification.profile)
        }
        let launch = try await fixture.supervisor.prepareEnabledInstances()
        let invalidID = ClientInstanceID.derive(profile: fixture.specifications[1].profile).value
        try expect(launch.omitted.contains { $0.instanceID == invalidID && $0.reasonCode == "credential_ineligible" }, "invalid credential omission missing")
        try await fixture.supervisor.run()
        let bootstrap = try fixture.process.decodedBootstrap()
        try expect(bootstrap.headlessWakes.map(\.profile) == ["codex-headless"], "valid credential was not isolated")
    }

    public static func headlessWakeBindingMissing() async throws {
        let fixture = try SupervisorFixture(specifications: [
            .init(profile: "worker-codex", adapter: .codex, digit: "1"),
            .init(profile: "codex-headless", adapter: .codex, digit: "c"),
        ])
        try fixture.instanceStore.setDeliveryMode(.headlessAppServer, profile: fixture.specifications[1].profile)
        let launch = try await fixture.supervisor.prepareEnabledInstances()
        let headlessID = ClientInstanceID.derive(profile: fixture.specifications[1].profile).value
        try expect(launch.omitted.contains {
            $0.instanceID == headlessID && $0.reasonCode == "headless_runtime_binding_missing"
        }, "missing headless binding was not recorded")
        do {
            try await fixture.supervisor.preflight()
            throw SupervisorContractFailure("release preflight accepted an omitted headless profile")
        } catch let error as ClientSupervisorError {
            try expect(error == .invalidBootstrap, "release preflight omission error changed")
        }
        try await fixture.supervisor.run()
        let bootstrap = try fixture.process.decodedBootstrap()
        try expect(bootstrap.headlessWakes.isEmpty, "headlessWakes emitted without binding file")
    }

    public static func dedicatedHeadlessDrainOmitsSupervisorClaimer() async throws {
        for loadedProfile in ["codex-bob-test", "codex-headless"] {
            let fixture = try SupervisorFixture(
                specifications: [
                    .init(profile: "worker-codex", adapter: .codex, digit: "1"),
                    .init(profile: "codex-bob-test", adapter: .codex, digit: "b"),
                    .init(profile: "codex-headless", adapter: .codex, digit: "c"),
                ],
                provisionHeadlessRuntimeBinding: true,
                dedicatedHeadlessDrainLoadedProfiles: [loadedProfile],
                headlessBindingProfiles: ["codex-bob-test", "codex-headless"]
            )
            for specification in fixture.specifications.dropFirst() {
                try fixture.instanceStore.setDeliveryMode(.headlessAppServer, profile: specification.profile)
            }
            let launch = try await fixture.supervisor.prepareEnabledInstances()
            let loaded = try require(fixture.specifications.first(where: { $0.profile.value == loadedProfile }), "loaded profile fixture missing")
            let loadedID = ClientInstanceID.derive(profile: loaded.profile).value
            try expect(launch.omitted.contains {
                $0.instanceID == loadedID && $0.reasonCode == "dedicated_headless_drain_loaded"
            }, "loaded dedicated drain was not treated as a dual-claimer block")
            try await fixture.supervisor.run()
            let bootstrap = try fixture.process.decodedBootstrap()
            try expect(!bootstrap.headlessWakes.contains { $0.profile == loadedProfile }, "supervisor claimed while dedicated drain LaunchAgent is loaded")
            try expect(bootstrap.headlessWakes.count == 1, "unblocked headless profile was lost")
            try expect(bootstrap.instances.count == 1, "worker instance was lost while omitting headlessWake")
        }
    }

    public static func headlessWakeNoGlobalRoomPin() async throws {
        let fixture = try SupervisorFixture(
            specifications: [
                .init(profile: "worker-codex", adapter: .codex, digit: "1"),
                .init(profile: "codex-bob-test", adapter: .codex, digit: "b"),
            ],
            provisionHeadlessRuntimeBinding: true,
            headlessBindingProfile: "codex-bob-test",
            includeHeadlessAllowedRoomId: false
        )
        try fixture.instanceStore.setDeliveryMode(.headlessAppServer, profile: fixture.specifications[1].profile)
        try await fixture.supervisor.run()
        let bootstrap = try fixture.process.decodedBootstrap()
        let headlessWake = try require(bootstrap.headlessWakes.first, "headlessWake missing for non-Mini Codex")
        try expect(headlessWake.profile == "codex-bob-test", "production Codex profile was not selected")
        try expect(headlessWake.allowedRoomId == nil, "global room pin was applied")
        try expect(headlessWake.allowedRoomId != "room_77aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "classic room_77 was used as a drain pin")
    }

    public static func grokBotExcludedFromHeadlessWake() async throws {
        let fixture = try SupervisorFixture(
            specifications: [
                .init(profile: "bob", adapter: .grokBot, digit: "b"),
                .init(profile: "codex-headless", adapter: .codex, digit: "c"),
            ],
            provisionGrokBotBinding: true,
            provisionHeadlessRuntimeBinding: true
        )
        try fixture.instanceStore.setDeliveryMode(.grokBot, profile: fixture.specifications[0].profile)
        try fixture.instanceStore.setDeliveryMode(.headlessAppServer, profile: fixture.specifications[1].profile)
        try await fixture.supervisor.run()
        let bootstrap = try fixture.process.decodedBootstrap()
        try expect(bootstrap.grokBotWake != nil, "grokBotWake missing")
        try expect(!bootstrap.headlessWakes.isEmpty, "headlessWake missing beside grok-bot")
        try expect(bootstrap.grokBotWake?.actorProfile == "bob", "grok-bot actor drifted")
        try expect(bootstrap.headlessWakes.first?.profile == "codex-headless", "Codex drain claimed grok-bot")
        try expect(bootstrap.headlessWakes.first?.profileInstanceId != bootstrap.grokBotWake?.binding.instanceId, "grok-bot entered the Codex pool")
    }

    public static func cursorAcpWakeBootstrap() async throws {
        let fixture = try SupervisorFixture(
            specifications: [
                .init(profile: "worker-codex", adapter: .codex, digit: "1"),
                .init(profile: "cursor-acp-shadow-test", adapter: .cursorAcp, digit: "a"),
            ],
            provisionCursorAcpRuntimeBinding: true,
            cursorAcpBindingProfiles: ["cursor-acp-shadow-test"]
        )
        try fixture.instanceStore.setDeliveryMode(.headlessCursorAcp, profile: fixture.specifications[1].profile)
        try await fixture.supervisor.run()
        let bootstrap = try fixture.process.decodedBootstrap()
        try expect(bootstrap.instances.count == 1, "worker count wrong with cursorAcpWakes")
        try expect(bootstrap.cursorAcpWakes.map(\.profile) == ["cursor-acp-shadow-test"], "cursorAcpWakes wrong")
        try expect(bootstrap.cursorAcpWakes.first?.shadowTestProfile == true, "shadowTestProfile missing")
        try expect(bootstrap.headlessWakes.isEmpty, "cursor-acp leaked into Codex headlessWakes")
        let encoded = try require(fixture.process.standardInput, "bootstrap missing")
        let raw = String(decoding: encoded, as: UTF8.self)
        try expect(!raw.contains(fixture.specifications[1].token), "cursor-acp mailbox token leaked")
        try expect(raw.contains("cursorAcpWakes"), "cursorAcpWakes key missing")
    }

    public static func cursorAcpWakeIsolatedFromCodexAndGrok() async throws {
        let fixture = try SupervisorFixture(
            specifications: [
                .init(profile: "bob", adapter: .grokBot, digit: "b"),
                .init(profile: "codex-headless", adapter: .codex, digit: "c"),
                .init(profile: "cursor-acp-shadow-test", adapter: .cursorAcp, digit: "a"),
            ],
            provisionGrokBotBinding: true,
            provisionHeadlessRuntimeBinding: true,
            provisionCursorAcpRuntimeBinding: true,
            cursorAcpBindingProfiles: ["cursor-acp-shadow-test"]
        )
        try fixture.instanceStore.setDeliveryMode(.grokBot, profile: fixture.specifications[0].profile)
        try fixture.instanceStore.setDeliveryMode(.headlessAppServer, profile: fixture.specifications[1].profile)
        try fixture.instanceStore.setDeliveryMode(.headlessCursorAcp, profile: fixture.specifications[2].profile)
        try await fixture.supervisor.run()
        let bootstrap = try fixture.process.decodedBootstrap()
        try expect(bootstrap.grokBotWake != nil, "grokBotWake missing")
        try expect(bootstrap.headlessWakes.map(\.profile) == ["codex-headless"], "Codex wake drifted")
        try expect(bootstrap.cursorAcpWakes.map(\.profile) == ["cursor-acp-shadow-test"], "Cursor ACP wake drifted")
        let cursorId = try require(bootstrap.cursorAcpWakes.first?.profileInstanceId, "cursor instance missing")
        try expect(bootstrap.headlessWakes.first?.profileInstanceId != cursorId, "Cursor ACP shared Codex instance id")
        try expect(bootstrap.grokBotWake?.binding.instanceId != cursorId, "Cursor ACP shared grok-bot instance id")
    }

    public static func noEligibleProfile() async throws {
        let fixture = try SupervisorFixture(specifications: [
            .init(profile: "bad-only", adapter: .codex, digit: "9", verificationFails: true),
        ])
        do {
            _ = try await fixture.supervisor.prepareEnabledInstances()
            throw SupervisorContractFailure("empty eligible set was accepted")
        } catch let error as ClientSupervisorError {
            try expect(error == .noEligibleInstances, "unexpected no-eligible error")
            try expect(String(describing: error) == "no eligible Triangle Client instances", "error was not bounded")
            try expect(!String(reflecting: error).contains(fixture.specifications[0].token), "error exposed token")
        }
    }

    public static func boundedAnonymousBootstrap() async throws {
        let fixture = try SupervisorFixture(specifications: [
            .init(profile: "bounded", adapter: .codex, digit: "a"),
        ])
        try await fixture.supervisor.run()
        let request = try require(fixture.process.request, "coordinator was not launched")
        let standardInput = try require(fixture.process.standardInput, "bootstrap did not reach stdin")
        try expect(standardInput.count <= ClientSupervisor.maximumBootstrapBytes, "bootstrap exceeded 1 MiB")
        try expect(request.arguments.count == 1, "bootstrap was added to argv")
        try expect(!request.arguments.joined().contains(fixture.specifications[0].token), "token entered argv")
        try expect(!request.environment.values.joined().contains(fixture.specifications[0].token), "token entered environment")
        try expect(fixture.process.persistedData.isEmpty, "process abstraction persisted bootstrap")
    }

    public static func cleanCoordinatorLaunch() async throws {
        let fixture = try SupervisorFixture(specifications: [
            .init(profile: "clean", adapter: .hermes, digit: "b"),
        ])
        try await fixture.supervisor.run()
        let request = try require(fixture.process.request, "coordinator was not launched")
        try expect(request.executable.path == "/trusted/node", "unverified coordinator executable selected")
        try expect(request.arguments == ["/trusted/client-supervisor-cli.mjs"], "coordinator accepted arbitrary flags")
        try expect(Set(request.environment.keys) == ["PATH", "LANG", "LC_ALL"], "coordinator inherited ambient environment")
        for forbidden in ["MESH_", "AGENT_ID", "CODEX_", "HERMES_", "TRIANGLE_INSTANCE"] {
            try expect(!request.environment.keys.contains { $0.contains(forbidden) }, "credential or instance selector entered coordinator environment")
        }
    }

    public static func productionOptInReachesCoordinator() async throws {
        let forwarded = ClientSupervisor.productionOptInEnvironment(from: [
            "TRIANGLE_CODEX_POOL_ENABLE": "1",
            "TRIANGLE_CODEX_POOL_SIZE": "2",
            "TRIANGLE_DESKTOP_HANDOFF_ENABLE": "1",
            "TRIANGLE_CODEX_LIVE_PROBE_FILE": "/tmp/probe",
            "MESH_AGENT_TOKEN": "secret",
            "HOME": "/Users/zhenyuhou",
        ])
        let rejected = ClientSupervisor.productionOptInEnvironment(from: [
            "TRIANGLE_CODEX_POOL_ENABLE": "1\n",
            "TRIANGLE_CODEX_POOL_SIZE": "9",
            "TRIANGLE_DESKTOP_HANDOFF_ENABLE": "/tmp",
        ])
        try expect(forwarded == [
            "TRIANGLE_CODEX_POOL_ENABLE": "1",
            "TRIANGLE_CODEX_POOL_SIZE": "2",
            "TRIANGLE_DESKTOP_HANDOFF_ENABLE": "1",
        ], "opt-in filter changed")
        try expect(rejected == ["TRIANGLE_CODEX_POOL_SIZE": "9"], "invalid opt-in was forwarded")

        let fixture = try SupervisorFixture(
            specifications: [
                .init(profile: "opt-in", adapter: .codex, digit: "f"),
            ],
            parentEnvironment: [
                "TRIANGLE_CODEX_POOL_ENABLE": "1",
                "TRIANGLE_CODEX_POOL_SIZE": "4",
                "TRIANGLE_DESKTOP_HANDOFF_ENABLE": "1",
                "MESH_AGENT_TOKEN": "secret-token",
                "TRIANGLE_CODEX_LIVE_PROBE_FILE": "/tmp/probe",
                "HOME": "/Users/zhenyuhou",
            ]
        )
        try await fixture.supervisor.run()
        let request = try require(fixture.process.request, "coordinator was not launched")
        try expect(request.environment["TRIANGLE_CODEX_POOL_ENABLE"] == "1", "pool enable was dropped")
        try expect(request.environment["TRIANGLE_CODEX_POOL_SIZE"] == "4", "pool size was dropped")
        try expect(request.environment["TRIANGLE_DESKTOP_HANDOFF_ENABLE"] == "1", "handoff enable was dropped")
        try expect(request.environment["MESH_AGENT_TOKEN"] == nil, "mesh token reached the coordinator")
        try expect(request.environment["TRIANGLE_CODEX_LIVE_PROBE_FILE"] == nil, "probe file reached the coordinator")
        try expect(request.environment["HOME"] == nil, "home reached the coordinator")
        try expect(!request.environment.values.joined().contains("secret-token"), "token entered environment")
    }

    public static func redactedDiagnostics() async throws {
        let fixture = try SupervisorFixture(specifications: [
            .init(profile: "diagnostic", adapter: .codex, digit: "c"),
        ])
        let launch = try await fixture.supervisor.prepareEnabledInstances()
        let outputs = [String(describing: launch), String(reflecting: launch)]
        for output in outputs {
            try expect(!output.contains(fixture.specifications[0].token), "prepared launch description exposed token")
            try expect(!output.contains(origin), "prepared launch description exposed mailbox origin")
        }
    }

    public static func shutdownLifecycle() async throws {
        let success = try SupervisorFixture(specifications: [
            .init(profile: "shutdown", adapter: .codex, digit: "d"),
        ])
        success.process.terminationStatus = 0
        try await success.supervisor.run()
        try expect(success.process.didWaitForTermination, "host returned before coordinator shutdown")

        let failure = try SupervisorFixture(specifications: [
            .init(profile: "shutdown-failure", adapter: .hermes, digit: "e"),
        ])
        failure.process.terminationStatus = 70
        do {
            try await failure.supervisor.run()
            throw SupervisorContractFailure("failed coordinator was treated as success")
        } catch let error as ClientSupervisorError {
            try expect(error == .processFailed, "unexpected process failure diagnostic")
        }
    }

    public static func subprocessEarlyExitIsContained() async throws {
        let runner = FoundationClientSupervisorProcessRunner(
            inputHandoffTimeoutMilliseconds: 100,
            terminationGraceMilliseconds: 50
        )
        let request = subprocessRequest(arguments: ["-c", "exit 23"])
        do {
            _ = try await runner.run(request, standardInput: Data(repeating: 0x61, count: ClientSupervisor.maximumBootstrapBytes))
            throw SupervisorContractFailure("early child exit was not contained")
        } catch let error as ClientSupervisorError {
            try expect(error == .processFailed, "early exit returned an unsanitized error")
        }
    }

    public static func subprocessBackpressureTimesOutAndReaps() async throws {
        try await withSubprocessPIDFile { pidFile in
            let runner = FoundationClientSupervisorProcessRunner(
                inputHandoffTimeoutMilliseconds: 40,
                terminationGraceMilliseconds: 80
            )
            let script = "echo $$ > '\(pidFile.path)'; sleep 30"
            let started = Date()
            do {
                _ = try await runner.run(
                    subprocessRequest(arguments: ["-c", script]),
                    standardInput: Data(repeating: 0x62, count: ClientSupervisor.maximumBootstrapBytes)
                )
                throw SupervisorContractFailure("non-reading child did not time out")
            } catch is ClientSupervisorError {}
            try expect(Date().timeIntervalSince(started) < 2, "stdin handoff timeout was not bounded")
            try expectProcessReaped(pidFile)
        }
    }

    public static func subprocessIgnoredTerminationIsKilled() async throws {
        try await withSubprocessPIDFile { pidFile in
            let runner = FoundationClientSupervisorProcessRunner(
                inputHandoffTimeoutMilliseconds: 40,
                terminationGraceMilliseconds: 40
            )
            let script = "echo $$ > '\(pidFile.path)'; trap '' TERM; while :; do sleep 1; done"
            do {
                _ = try await runner.run(
                    subprocessRequest(arguments: ["-c", script]),
                    standardInput: Data(repeating: 0x63, count: ClientSupervisor.maximumBootstrapBytes)
                )
                throw SupervisorContractFailure("TERM-ignoring child was not killed")
            } catch is ClientSupervisorError {}
            try expectProcessReaped(pidFile)
        }
    }

    public static func signalPreservationAndSerialization() async throws {
        let beforeInterrupt = signalDisposition(SIGINT)
        let beforeTerminate = signalDisposition(SIGTERM)
        let root = FileManager.default.temporaryDirectory.resolvingSymlinksInPath()
            .appendingPathComponent("triangle-supervisor-serialization-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false)
        defer { try? FileManager.default.removeItem(at: root) }
        let marker = root.appendingPathComponent("active")
        let violation = root.appendingPathComponent("overlap")
        let script = "if [ -e '\(marker.path)' ]; then : > '\(violation.path)'; fi; : > '\(marker.path)'; sleep 0.12; rm -f '\(marker.path)'"
        let runnerA = FoundationClientSupervisorProcessRunner(inputHandoffTimeoutMilliseconds: 500, terminationGraceMilliseconds: 50)
        let runnerB = FoundationClientSupervisorProcessRunner(inputHandoffTimeoutMilliseconds: 500, terminationGraceMilliseconds: 50)
        async let first = runnerA.run(subprocessRequest(arguments: ["-c", script]), standardInput: Data())
        async let second = runnerB.run(subprocessRequest(arguments: ["-c", script]), standardInput: Data())
        let statuses = try await [first, second]
        try expect(statuses == [0, 0], "serialized subprocess failed")
        try expect(!FileManager.default.fileExists(atPath: violation.path), "concurrent runners overlapped process-global signal ownership")
        try expect(signalDisposition(SIGINT) == beforeInterrupt, "SIGINT disposition was not restored exactly")
        try expect(signalDisposition(SIGTERM) == beforeTerminate, "SIGTERM disposition was not restored exactly")
    }

    public static func readinessMarkerContract() async throws {
        let root = FileManager.default.temporaryDirectory.resolvingSymlinksInPath()
            .appendingPathComponent("triangle-ready-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        defer { try? FileManager.default.removeItem(at: root) }
        let marker = root.appendingPathComponent("ready.json")
        let activation = root.appendingPathComponent("activate.json")
        let bootstrap = Data("{}".utf8)
        let digest = SHA256.hash(data: bootstrap).map { String(format: "%02x", $0) }.joined()
        let generation = "11111111-1111-4111-8111-111111111111"
        let script = "cat >/dev/null; printf '%s\\n' '{\"type\":\"triangle-client-supervisor-ready\",\"generation\":\"\(generation)\",\"parentPid\":4242,\"configDigest\":\"\(digest)\"}'"
        let runner = FoundationClientSupervisorProcessRunner(
            inputHandoffTimeoutMilliseconds: 500,
            terminationGraceMilliseconds: 50,
            readinessMarkerURL: marker,
            readinessTimeoutMilliseconds: 500,
            readinessRequired: true,
            parentPID: 4242
        )
        _ = try await runner.run(subprocessRequest(arguments: ["-c", script]), standardInput: bootstrap)
        let attributes = try FileManager.default.attributesOfItem(atPath: marker.path)
        try expect((attributes[.posixPermissions] as? NSNumber)?.intValue == 0o600, "readiness marker mode changed")
        let value = try JSONSerialization.jsonObject(with: Data(contentsOf: marker)) as? [String: Any]
        try expect(value?["version"] as? Int == 1, "readiness marker version changed")
        try expect(value?["parentPid"] as? Int == 4242, "readiness marker was not bound to its host")
        try expect(value?["generation"] as? String == generation, "readiness marker was not bound to coordinator generation")
        try expect(value?["configDigest"] as? String == digest, "readiness marker was not bound to bootstrap")
        let activationValue = try JSONSerialization.jsonObject(with: Data(contentsOf: activation)) as? [String: Any]
        try expect(activationValue?["generation"] as? String == generation, "activation marker was not bound to coordinator generation")
        try expect(activationValue?["parentPid"] as? Int == 4242, "activation marker was not bound to its host")
        try expect(activationValue?["configDigest"] as? String == digest, "activation marker was not bound to bootstrap")

        try FileManager.default.removeItem(at: marker)
        try? FileManager.default.removeItem(at: activation)
        let mismatch = "cat >/dev/null; printf '%s\\n' '{\"type\":\"triangle-client-supervisor-ready\",\"generation\":\"\(generation)\",\"parentPid\":4242,\"configDigest\":\"\(String(repeating: "0", count: 64))\"}'"
        do {
            _ = try await runner.run(subprocessRequest(arguments: ["-c", mismatch]), standardInput: bootstrap)
            throw SupervisorContractFailure("mismatched readiness acknowledgement was accepted")
        } catch is ClientSupervisorError {}
        try expect(!FileManager.default.fileExists(atPath: marker.path), "failed coordinator left a false readiness marker")
    }
}

private struct InstanceSpecification: Sendable {
    let profile: ProfileName
    let adapter: RuntimeAdapter
    let token: String
    let agentID: AgentID
    let handle: MailboxHandle
    let verificationFails: Bool

    init(profile: String, adapter: RuntimeAdapter, digit: Character, verificationFails: Bool = false) throws {
        self.profile = try ProfileName(profile)
        self.adapter = adapter
        token = "mesh_" + String(repeating: digit, count: 64)
        agentID = try AgentID("agent_" + String(repeating: digit, count: 32))
        let normalized = "agent-" + String(repeating: digit, count: 3)
        handle = try MailboxHandle(normalized)
        self.verificationFails = verificationFails
    }
}

private final class SupervisorFixture: @unchecked Sendable {
    let specifications: [InstanceSpecification]
    let instanceStore: InMemoryClientInstanceStore
    let credentials: RecordingMultiCredentialStore
    let journal: InMemoryEnrollmentJournal
    let process = RecordingSupervisorProcess()
    let supervisor: ClientSupervisor
    let helperRoot: URL

    init(
        specifications: [InstanceSpecification],
        events: EventLog = EventLog(),
        resolverFailureAt: Int? = nil,
        coordinatorFails: Bool = false,
        provisionAppServerBinding: Bool = false,
        provisionGrokBotBinding: Bool = false,
        provisionHeadlessRuntimeBinding: Bool = false,
        provisionCursorAcpRuntimeBinding: Bool = false,
        dedicatedHeadlessDrainLoaded: Bool = false,
        dedicatedHeadlessDrainLoadedProfiles: Set<String> = [],
        headlessBindingProfile: String? = nil,
        headlessBindingProfiles: [String]? = nil,
        cursorAcpBindingProfiles: [String]? = nil,
        duplicateHeadlessInstanceID: Bool = false,
        headlessStateRoots: [String: String] = [:],
        headlessPollIntervalMs: Any = 1_000,
        includeHeadlessAllowedRoomId: Bool = false,
        parentEnvironment: [String: String] = [:]
    ) throws {
        self.specifications = specifications
        let instances = InMemoryClientInstanceStore()
        instanceStore = instances
        journal = InMemoryEnrollmentJournal()
        helperRoot = FileManager.default.temporaryDirectory
            .resolvingSymlinksInPath()
            .appendingPathComponent("triangle-supervisor-wake-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: helperRoot, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        let helperBinary = helperRoot.appendingPathComponent("triangle-mailbox")
        FileManager.default.createFile(atPath: helperBinary.path, contents: Data("#!/bin/sh\nexit 0\n".utf8), attributes: [.posixPermissions: 0o700])
        let cursorURL = helperRoot.appendingPathComponent("wake-cursor.json")
        let appServerBindingURL = helperRoot.appendingPathComponent("app-server-binding.json")
        let appServerWakeCursorURL = helperRoot.appendingPathComponent("app-server-wake-cursor.json")
        let appServerAuthTokenURL = helperRoot.appendingPathComponent("app-server-ws.token")
        let grokBotBindingURL = helperRoot.appendingPathComponent("grok-bot-binding.json")
        let grokBotWakeCursorURL = helperRoot.appendingPathComponent("grok-bot-wake-cursor.json")
        let grokBotWebhookURLPath = helperRoot.appendingPathComponent("grok-bot-webhook.url")
        let grokBotWebhookKeyPath = helperRoot.appendingPathComponent("grok-bot-webhook.key")
        let headlessRuntimeBindingURL = helperRoot.appendingPathComponent("headless-runtime-binding.json")
        let cursorAcpRuntimeBindingURL = helperRoot.appendingPathComponent("cursor-acp-runtime-binding.json")
        let installationID = try InstallationID("inst_N7VhDq3mQ2")
        var bindings: [ProfileName: CredentialBinding] = [:]
        var identities: [String: IdentityResult] = [:]
        for specification in specifications {
            let instance = try ClientInstance(
                profile: specification.profile,
                runtimeAdapter: specification.adapter,
                deliveryMode: .worker
            )
            try instances.create(instance)
            let binding = CredentialBinding(
                origin: try MeshOrigin(ClientSupervisorContractCases.origin),
                agentID: specification.agentID,
                handle: specification.handle,
                token: try MeshToken(specification.token)
            )
            bindings[specification.profile] = binding
            identities[specification.token] = specification.verificationFails
                ? .failure
                : .identity(id: specification.agentID, handle: specification.handle)
            try journal.write(.testing(
                profile: specification.profile,
                origin: binding.origin,
                state: .verified,
                agentID: binding.agentID,
                handle: binding.handle,
                reasonCode: "identity_verified"
            ))
        }
        if provisionAppServerBinding {
            let interactive = try require(
                specifications.first(where: { $0.profile.value.contains("interactive") }),
                "interactive specification required for app-server binding"
            )
            let instanceId = ClientInstanceID.derive(profile: interactive.profile).value
            let bindingObject: [String: Any] = [
                "adapterVersion": "1",
                "enabled": true,
                "installationId": installationID.value,
                "instanceId": instanceId,
                "agentId": interactive.agentID.value,
                "roomScope": "room_" + String(repeating: "a", count: 32),
                "serverIdentity": "codex-app-server/test",
                "endpoint": "ws://127.0.0.1:9999/rpc",
                "threadId": "01a06f9f-2db1-7143-b8b9-08c634cc7999",
            ]
            let bindingData = try JSONSerialization.data(withJSONObject: bindingObject, options: [.sortedKeys])
            try bindingData.write(to: appServerBindingURL)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: appServerBindingURL.path)
            try Data("desktop-canary-token\n".utf8).write(to: appServerAuthTokenURL)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: appServerAuthTokenURL.path)
        }
        if provisionGrokBotBinding {
            let bob = try require(
                specifications.first(where: { $0.profile.value.contains("grok") || $0.adapter == .grokBot }),
                "grok-bot specification required for grok-bot binding"
            )
            let instanceId = ClientInstanceID.derive(profile: bob.profile).value
            let bindingObject: [String: Any] = [
                "adapterVersion": "1",
                "enabled": true,
                "installationId": installationID.value,
                "instanceId": instanceId,
                "agentId": bob.agentID.value,
                "profile": bob.profile.value,
                "grokAgentId": "12aedccc-8662-4a7f-84da-3d35c9e97842",
                "wakeMode": "webhook",
            ]
            let bindingData = try JSONSerialization.data(withJSONObject: bindingObject, options: [.sortedKeys])
            try bindingData.write(to: grokBotBindingURL)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: grokBotBindingURL.path)
            try Data("https://example.test/mesh/wake\n".utf8).write(to: grokBotWebhookURLPath)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: grokBotWebhookURLPath.path)
            try Data("webhook-secret-key\n".utf8).write(to: grokBotWebhookKeyPath)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: grokBotWebhookKeyPath.path)
        }
        if provisionHeadlessRuntimeBinding {
            let selectedProfiles = headlessBindingProfiles ?? [headlessBindingProfile ?? "codex-headless"]
            let selected = try selectedProfiles.map { profile in
                try require(specifications.first(where: { $0.profile.value == profile }), "headless Codex specification required for v2 binding")
            }
            let common: [String: Any] = [
                "adapterVersion": "1",
                "installationId": installationID.value,
                "workingDirectory": "/srv/triangle-work",
                "codexHome": "/private/codex-home",
                "command": "/trusted/bin/codex",
                "pollIntervalMs": headlessPollIntervalMs,
            ]
            let firstID = selected.first.map { ClientInstanceID.derive(profile: $0.profile).value }
            let profiles: [[String: Any]] = selected.enumerated().map { index, headless in
                [
                    "profile": headless.profile.value,
                    "instanceId": duplicateHeadlessInstanceID && index > 0 ? firstID! : ClientInstanceID.derive(profile: headless.profile).value,
                    "stateRoot": headlessStateRoots[headless.profile.value] ?? "/private/headless-state/\(headless.profile.value)",
                ]
            }
            var bindingObject: [String: Any] = ["version": 2, "common": common, "profiles": profiles]
            if includeHeadlessAllowedRoomId { bindingObject["allowedRoomId"] = "room_8594d12312e14afbb291fcff60a22048" }
            let bindingData = try JSONSerialization.data(withJSONObject: bindingObject, options: [.sortedKeys])
            try bindingData.write(to: headlessRuntimeBindingURL)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: headlessRuntimeBindingURL.path)
        }
        if provisionCursorAcpRuntimeBinding {
            let selectedProfiles = cursorAcpBindingProfiles ?? ["cursor-acp-shadow-test"]
            let selected = try selectedProfiles.map { profile in
                try require(
                    specifications.first(where: { $0.profile.value == profile }),
                    "cursor-acp specification required for binding"
                )
            }
            let common: [String: Any] = [
                "adapterVersion": "1",
                "installationId": installationID.value,
                "workingDirectory": "/srv/triangle-cursor-work",
                "cursorHome": "/private/cursor-acp-home",
                "command": "/trusted/bin/agent",
                "pollIntervalMs": 1_000,
            ]
            let profiles: [[String: Any]] = selected.map { entry in
                [
                    "profile": entry.profile.value,
                    "instanceId": ClientInstanceID.derive(profile: entry.profile).value,
                    "stateRoot": "/private/cursor-acp-state/\(entry.profile.value)",
                    "shadowTestProfile": true,
                ]
            }
            let bindingObject: [String: Any] = ["version": 1, "common": common, "profiles": profiles]
            let bindingData = try JSONSerialization.data(withJSONObject: bindingObject, options: [.sortedKeys])
            try bindingData.write(to: cursorAcpRuntimeBindingURL)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: cursorAcpRuntimeBindingURL.path)
        }
        credentials = RecordingMultiCredentialStore(bindings: bindings, events: events)
        let gate = VerifiedCredentialGate(
            store: credentials,
            transport: MultiIdentityTransport(results: identities),
            reservation: InMemoryEnrollmentReservation(),
            journal: journal
        )
        supervisor = ClientSupervisor(
            instanceStore: instances,
            gate: gate,
            resolver: RecordingSupervisorResolver(events: events, failureAt: resolverFailureAt, coordinatorFails: coordinatorFails),
            processRunner: process,
            installationIdentity: InMemoryClientInstallationIdentityStore(installationID: installationID),
            helperExecutableURL: helperBinary,
            wakeCursorURL: cursorURL,
            appServerBindingURL: appServerBindingURL,
            appServerWakeCursorURL: appServerWakeCursorURL,
            appServerAuthTokenURL: appServerAuthTokenURL,
            grokBotBindingURL: grokBotBindingURL,
            grokBotWakeCursorURL: grokBotWakeCursorURL,
            grokBotWebhookURLPath: grokBotWebhookURLPath,
            grokBotWebhookKeyPath: grokBotWebhookKeyPath,
            headlessRuntimeBindingURL: headlessRuntimeBindingURL,
            cursorAcpRuntimeBindingURL: cursorAcpRuntimeBindingURL,
            isDedicatedHeadlessDrainLoaded: { profile in
                dedicatedHeadlessDrainLoaded || dedicatedHeadlessDrainLoadedProfiles.contains(profile)
            },
            parentEnvironment: parentEnvironment
        )
    }

    deinit {
        try? FileManager.default.removeItem(at: helperRoot)
    }
}

private final class EventLog: @unchecked Sendable {
    private let lock = NSLock()
    private var storage: [String] = []
    var values: [String] { lock.withLock { storage } }
    func append(_ value: String) { lock.withLock { storage.append(value) } }
}

private final class RecordingMultiCredentialStore: CredentialStore, @unchecked Sendable {
    private let lock = NSLock()
    private let bindings: [ProfileName: CredentialBinding]
    private let events: EventLog
    private var reads = 0
    var readCount: Int { lock.withLock { reads } }
    init(bindings: [ProfileName: CredentialBinding], events: EventLog) { self.bindings = bindings; self.events = events }
    func create(_ binding: CredentialBinding, for profile: ProfileName) throws { throw CredentialStoreError.duplicateItem }
    func read(for profile: ProfileName) throws -> CredentialBinding {
        lock.withLock { reads += 1 }
        events.append("credential:\(profile.value)")
        guard let binding = bindings[profile] else { throw CredentialStoreError.itemNotFound }
        return binding
    }
    func replace(_ binding: CredentialBinding, for profile: ProfileName, confirmation: CredentialReplacementConfirmation) throws { throw CredentialStoreError.replacementNotConfirmed }
    func delete(for profile: ProfileName) throws { throw CredentialStoreError.itemNotFound }
}

private enum IdentityResult: Sendable { case identity(id: AgentID, handle: MailboxHandle); case failure }
private struct MultiIdentityTransport: MeshTransport {
    let results: [String: IdentityResult]
    func send(_ request: MeshHTTPRequest) async throws -> MeshHTTPResponse {
        let authorization = request.headers["Authorization"] ?? ""
        let token = String(authorization.dropFirst("Bearer ".count))
        guard let result = results[token] else { throw MeshClientError.transportUnavailable }
        switch result {
        case .failure:
            return MeshHTTPResponse(statusCode: 401, headers: ["Content-Type": "application/json"], body: Data("{}".utf8), finalURL: request.url)
        case .identity(let id, let handle):
            let body = try JSONSerialization.data(withJSONObject: ["agent": [
                "id": id.value,
                "name": "Triangle Client Test",
                "handle": handle.value,
                "registrationMode": "mailbox",
                "endpointUrl": ClientSupervisorContractCases.origin + "/api/v1/mailbox",
            ]])
            return MeshHTTPResponse(statusCode: 200, headers: ["Content-Type": "application/json"], body: body, finalURL: request.url)
        }
    }
}

private struct RecordingSupervisorResolver: ClientSupervisorCommandResolving {
    let events: EventLog
    let failureAt: Int?
    let coordinatorFails: Bool
    private let lock = NSLock()
    private let counter = ResolverCounter()

    func resolveAdapter(for instance: ClientInstance) throws -> WorkerCommand {
        let index = counter.next()
        events.append("resolve:\(instance.profile.value)")
        if index == failureAt { throw WorkerLauncherError.unsafeInstallation }
        let identifier = instance.instanceID.value
        let adapter = instance.runtimeAdapter.rawValue
        return WorkerCommand(
            executable: URL(fileURLWithPath: "/trusted/node"),
            arguments: ["/trusted/\(adapter)-runner.mjs"],
            workingDirectory: URL(fileURLWithPath: "/trusted"),
            environment: [
                "PATH": "/trusted/bin",
                "TRIANGLE_INSTANCE_ID": identifier,
                "TRIANGLE_INSTANCE_TEMP_ROOT": "/private/cache/\(identifier)",
                adapter == "codex" ? "CODEX_CLI" : "HERMES_CLI": "/trusted/\(adapter)",
                adapter == "codex" ? "CODEX_HOME" : "HERMES_HOME": "/private/model-state/\(identifier)",
            ]
        )
    }

    func resolveCoordinator(for instances: [ClientInstance]) throws -> WorkerCommand {
        events.append("resolve:coordinator")
        if coordinatorFails { throw WorkerLauncherError.invalidManifest }
        return WorkerCommand(
            executable: URL(fileURLWithPath: "/trusted/node"),
            arguments: ["/trusted/client-supervisor-cli.mjs"],
            workingDirectory: URL(fileURLWithPath: "/trusted"),
            environment: ["PATH": "/trusted/bin", "LANG": "C", "LC_ALL": "C"]
        )
    }
}

private final class ResolverCounter: @unchecked Sendable {
    private let lock = NSLock(); private var value = 0
    func next() -> Int { lock.withLock { defer { value += 1 }; return value } }
}

private final class RecordingSupervisorProcess: ClientSupervisorProcessRunning, @unchecked Sendable {
    private let lock = NSLock()
    var terminationStatus: Int32 = 0
    private(set) var request: ClientSupervisorProcessRequest?
    private(set) var standardInput: Data?
    private(set) var persistedData = Data()
    private(set) var didWaitForTermination = false
    private var invocations = 0
    var invocationCount: Int { lock.withLock { invocations } }
    func run(_ request: ClientSupervisorProcessRequest, standardInput: Data) async throws -> Int32 {
        lock.withLock {
            self.request = request
            self.standardInput = standardInput
            didWaitForTermination = true
            invocations += 1
        }
        return terminationStatus
    }
    func decodedBootstrap() throws -> TestBootstrap {
        let data = try require(standardInput, "bootstrap was not written to stdin")
        return try JSONDecoder().decode(TestBootstrap.self, from: data)
    }
}

private struct TestBootstrap: Decodable {
    let version: Int
    let maxConcurrentReasoners: Int
    let instances: [TestBootstrapInstance]
    let eventWake: TestEventWake?
    let appServerWake: TestAppServerWake?
    let grokBotWake: TestGrokBotWake?
    let headlessWakes: [TestHeadlessWake]
    let cursorAcpWakes: [TestCursorAcpWake]

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        version = try values.decode(Int.self, forKey: .version)
        maxConcurrentReasoners = try values.decode(Int.self, forKey: .maxConcurrentReasoners)
        instances = try values.decode([TestBootstrapInstance].self, forKey: .instances)
        eventWake = try values.decodeIfPresent(TestEventWake.self, forKey: .eventWake)
        appServerWake = try values.decodeIfPresent(TestAppServerWake.self, forKey: .appServerWake)
        grokBotWake = try values.decodeIfPresent(TestGrokBotWake.self, forKey: .grokBotWake)
        headlessWakes = try values.decodeIfPresent([TestHeadlessWake].self, forKey: .headlessWakes) ?? []
        cursorAcpWakes = try values.decodeIfPresent([TestCursorAcpWake].self, forKey: .cursorAcpWakes) ?? []
    }

    private enum CodingKeys: String, CodingKey {
        case version, maxConcurrentReasoners, instances, eventWake, appServerWake, grokBotWake, headlessWakes, cursorAcpWakes
    }
}
private struct TestBootstrapInstance: Decodable {
    let instanceId: String
    let mailbox: TestMailbox
    let runner: TestRunner
    let runnerEnvironment: [String: String]
}
private struct TestMailbox: Decodable { let meshUrl: String; let meshToken: String; let recipientId: String; let pageLimit: Int }
private struct TestRunner: Decodable { let command: String; let args: [String]; let timeoutMs: Int }
private struct TestEventWake: Decodable {
    let installationId: String
    let helperPath: String
    let cursorPath: String
    let actorProfile: String
    let ensureBeforeWatch: Bool
    let profiles: [TestEventWakeProfile]
    let drains: [TestBootstrapInstance]
}
private struct TestEventWakeProfile: Decodable {
    let instanceId: String
    let agentId: String
}
private struct TestAppServerWake: Decodable {
    let installationId: String
    let helperPath: String
    let cursorPath: String
    let bindingPath: String
    let actorProfile: String
    let ensureBeforeWatch: Bool
    let authTokenFile: String?
    let authTokenEnv: String?
    let binding: TestAppServerBinding
}
private struct TestAppServerBinding: Decodable {
    let adapterVersion: String
    let enabled: Bool
    let installationId: String
    let instanceId: String
    let agentId: String
    let roomScope: String
    let serverIdentity: String
    let endpoint: String
    let threadId: String
}
private struct TestGrokBotWake: Decodable {
    let installationId: String
    let helperPath: String
    let cursorPath: String
    let bindingPath: String
    let webhookUrlPath: String
    let webhookKeyPath: String
    let actorProfile: String
    let ensureBeforeWatch: Bool
    let binding: TestGrokBotBinding
}
private struct TestGrokBotBinding: Decodable {
    let adapterVersion: String
    let enabled: Bool
    let installationId: String
    let instanceId: String
    let agentId: String
    let profile: String
    let grokAgentId: String
    let wakeMode: String
}
private struct TestHeadlessWake: Decodable {
    let profile: String
    let profileInstanceId: String
    let helperPath: String
    let allowedRoomId: String?
    let workingDirectory: String
    let codexHome: String
    let stateRoot: String
    let command: String
    let pollIntervalMs: Int
}
private struct TestCursorAcpWake: Decodable {
    let profile: String
    let profileInstanceId: String
    let helperPath: String
    let workingDirectory: String
    let cursorHome: String
    let stateRoot: String
    let command: String
    let pollIntervalMs: Int
    let shadowTestProfile: Bool
}

private struct SupervisorContractFailure: Error, CustomStringConvertible { let description: String; init(_ description: String) { self.description = description } }
private func expect(_ condition: @autoclosure () -> Bool, _ message: String) throws { if !condition() { throw SupervisorContractFailure(message) } }
private func require<T>(_ value: T?, _ message: String) throws -> T { guard let value else { throw SupervisorContractFailure(message) }; return value }

private func subprocessRequest(arguments: [String]) -> ClientSupervisorProcessRequest {
    ClientSupervisorProcessRequest(
        executable: URL(fileURLWithPath: "/bin/sh"),
        arguments: arguments,
        workingDirectory: URL(fileURLWithPath: "/private/tmp"),
        environment: ["PATH": "/usr/bin:/bin", "LANG": "C", "LC_ALL": "C"]
    )
}

private func withSubprocessPIDFile(_ body: (URL) async throws -> Void) async throws {
    let file = FileManager.default.temporaryDirectory.resolvingSymlinksInPath()
        .appendingPathComponent("triangle-supervisor-pid-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: file) }
    try await body(file)
}

private func expectProcessReaped(_ pidFile: URL) throws {
    let text = try String(contentsOf: pidFile, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
    guard let pid = Int32(text) else { throw SupervisorContractFailure("subprocess PID was not recorded") }
    errno = 0
    let result = Darwin.kill(pid, 0)
    try expect(result == -1 && errno == ESRCH, "subprocess was not reaped")
}

private func signalDisposition(_ signalNumber: Int32) -> Data {
    typealias SigactionFunction = @convention(c) (Int32, UnsafePointer<sigaction>?, UnsafeMutablePointer<sigaction>?) -> Int32
    guard let symbol = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "sigaction") else { return Data() }
    let function = unsafeBitCast(symbol, to: SigactionFunction.self)
    var action = sigaction()
    _ = function(signalNumber, nil, &action)
    return withUnsafeBytes(of: &action) { Data($0) }
}
