import Darwin
import CryptoKit
import Foundation

public enum ClientSupervisorError: Error, Equatable, Sendable, CustomStringConvertible, CustomDebugStringConvertible {
    case invalidInstances
    case runtimeUnavailable
    case noEligibleInstances
    case invalidBootstrap
    case processFailed

    public var description: String {
        switch self {
        case .invalidInstances: "Triangle Client instances are invalid"
        case .runtimeUnavailable: "Triangle Client runtime is unavailable"
        case .noEligibleInstances: "no eligible Triangle Client instances"
        case .invalidBootstrap: "Triangle Client bootstrap is invalid"
        case .processFailed: "Triangle Client supervisor failed"
        }
    }
    public var debugDescription: String { description }
}

public struct ClientSupervisorProcessRequest: Equatable, Sendable {
    public let executable: URL
    public let arguments: [String]
    public let workingDirectory: URL
    public let environment: [String: String]

    public init(executable: URL, arguments: [String], workingDirectory: URL, environment: [String: String]) {
        self.executable = executable
        self.arguments = arguments
        self.workingDirectory = workingDirectory
        self.environment = environment
    }
}

public protocol ClientSupervisorProcessRunning: Sendable {
    func run(_ request: ClientSupervisorProcessRequest, standardInput: Data) async throws -> Int32
}

public struct PreparedClientSupervisorInstance: Equatable, Sendable {
    public let instanceID: String
    public let runtimeAdapter: RuntimeAdapter
}

public struct OmittedClientSupervisorInstance: Equatable, Sendable, CustomStringConvertible, CustomDebugStringConvertible {
    public let instanceID: String
    public let reasonCode: String
    public var description: String { "OmittedClientSupervisorInstance(instanceID: \(instanceID), reasonCode: \(reasonCode))" }
    public var debugDescription: String { description }
}

public struct PreparedClientSupervisorLaunch: Sendable, CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
    public let instances: [PreparedClientSupervisorInstance]
    public let eventWakeProfileCount: Int
    public let omitted: [OmittedClientSupervisorInstance]
    let command: WorkerCommand
    let bootstrap: Data

    public var description: String {
        "PreparedClientSupervisorLaunch(instances: \(instances.count), eventWakeProfiles: \(eventWakeProfileCount), omitted: \(omitted.count), bootstrap: <redacted>)"
    }
    public var debugDescription: String { description }
    public var customMirror: Mirror {
        Mirror(
            self,
            children: [
                "instances": instances.count,
                "eventWakeProfiles": eventWakeProfileCount,
                "omitted": omitted.count,
                "bootstrap": "<redacted>",
            ],
            displayStyle: .struct
        )
    }
}

public struct ClientSupervisor: Sendable {
    public static let maximumBootstrapBytes = 1024 * 1024
    private static let maximumRunnerTimeoutMilliseconds = 600_000
    private static let coordinatorEnvironmentKeys: Set<String> = [
        "PATH", "LANG", "LC_ALL", "NO_COLOR",
        "TRIANGLE_CODEX_POOL_ENABLE", "TRIANGLE_CODEX_POOL_SIZE", "TRIANGLE_DESKTOP_HANDOFF_ENABLE",
        "TRIANGLE_CURSOR_ACP_SHADOW_ENABLE",
    ]
    private static let productionOptInEnvironmentKeys: Set<String> = [
        "TRIANGLE_CODEX_POOL_ENABLE", "TRIANGLE_CODEX_POOL_SIZE", "TRIANGLE_DESKTOP_HANDOFF_ENABLE",
        "TRIANGLE_CURSOR_ACP_SHADOW_ENABLE",
    ]

    /// Forwards only the production pool and idle-handoff opt-in from the helper
    /// process. Launchd exports those keys on the helper, and the coordinator
    /// child otherwise starts with a replaced environment that drops them.
    /// Values are a single digit so a secret or path cannot ride along.
    public static func productionOptInEnvironment(from environment: [String: String]) -> [String: String] {
        var forwarded: [String: String] = [:]
        for key in productionOptInEnvironmentKeys.sorted() {
            guard let value = environment[key],
                  value.range(of: "^[0-9]$", options: .regularExpression) != nil
            else { continue }
            forwarded[key] = value
        }
        return forwarded
    }

    private let instanceStore: any ClientInstanceStore
    private let gate: VerifiedCredentialGate
    private let workloadKeyStore: any WorkloadKeyStore
    private let resolver: any ClientSupervisorCommandResolving
    private let processRunner: any ClientSupervisorProcessRunning
    private let installationIdentity: any ClientInstallationIdentityStore
    private let helperExecutableURL: URL
    private let wakeCursorURL: URL
    private let appServerBindingURL: URL
    private let appServerWakeCursorURL: URL
    private let appServerAuthTokenURL: URL
    private let grokBotBindingURL: URL
    private let grokBotWakeCursorURL: URL
    private let grokBotWebhookURLPath: URL
    private let grokBotWebhookKeyPath: URL
    private let headlessRuntimeBindingURL: URL
    private let cursorAcpRuntimeBindingURL: URL
    private let isDedicatedHeadlessDrainLoaded: @Sendable (String) -> Bool
    private let isDedicatedCursorAcpDrainLoaded: @Sendable (String) -> Bool
    private let parentEnvironment: [String: String]

    public init(
        instanceStore: any ClientInstanceStore,
        gate: VerifiedCredentialGate,
        workloadKeyStore: (any WorkloadKeyStore)? = nil,
        resolver: any ClientSupervisorCommandResolving,
        processRunner: any ClientSupervisorProcessRunning,
        installationIdentity: (any ClientInstallationIdentityStore)? = nil,
        helperExecutableURL: URL? = nil,
        wakeCursorURL: URL? = nil,
        appServerBindingURL: URL? = nil,
        appServerWakeCursorURL: URL? = nil,
        appServerAuthTokenURL: URL? = nil,
        grokBotBindingURL: URL? = nil,
        grokBotWakeCursorURL: URL? = nil,
        grokBotWebhookURLPath: URL? = nil,
        grokBotWebhookKeyPath: URL? = nil,
        headlessRuntimeBindingURL: URL? = nil,
        cursorAcpRuntimeBindingURL: URL? = nil,
        isDedicatedHeadlessDrainLoaded: (@Sendable (String) -> Bool)? = nil,
        isDedicatedCursorAcpDrainLoaded: (@Sendable (String) -> Bool)? = nil,
        parentEnvironment: [String: String] = ProcessInfo.processInfo.environment
    ) {
        self.instanceStore = instanceStore
        self.gate = gate
        #if canImport(Security)
        if let workloadKeyStore {
            self.workloadKeyStore = workloadKeyStore
        } else if LocalCredentialStores.fileCredentialsEnabled {
            self.workloadKeyStore = FileWorkloadKeyStore()
        } else {
            self.workloadKeyStore = KeychainWorkloadKeyStore()
        }
        #else
        self.workloadKeyStore = workloadKeyStore ?? InMemoryWorkloadKeyStore()
        #endif
        self.resolver = resolver
        self.processRunner = processRunner
        self.installationIdentity = installationIdentity ?? FileClientInstallationIdentityStore()
        let home = FileManager.default.homeDirectoryForCurrentUser
        let clientRoot = home.appendingPathComponent("Library/Application Support/The Triangle/client")
        self.helperExecutableURL = helperExecutableURL
            ?? home.appendingPathComponent("Library/Application Support/The Triangle/bin/triangle-mailbox")
        self.wakeCursorURL = wakeCursorURL
            ?? clientRoot.appendingPathComponent("wake-cursor.json")
        self.appServerBindingURL = appServerBindingURL
            ?? clientRoot.appendingPathComponent("app-server-binding.json")
        self.appServerWakeCursorURL = appServerWakeCursorURL
            ?? clientRoot.appendingPathComponent("app-server-wake-cursor.json")
        self.appServerAuthTokenURL = appServerAuthTokenURL
            ?? clientRoot.appendingPathComponent("app-server-ws.token")
        self.grokBotBindingURL = grokBotBindingURL
            ?? clientRoot.appendingPathComponent("grok-bot-binding.json")
        self.grokBotWakeCursorURL = grokBotWakeCursorURL
            ?? clientRoot.appendingPathComponent("grok-bot-wake-cursor.json")
        self.grokBotWebhookURLPath = grokBotWebhookURLPath
            ?? clientRoot.appendingPathComponent("grok-bot-webhook.url")
        self.grokBotWebhookKeyPath = grokBotWebhookKeyPath
            ?? clientRoot.appendingPathComponent("grok-bot-webhook.key")
        self.headlessRuntimeBindingURL = headlessRuntimeBindingURL
            ?? clientRoot.appendingPathComponent("headless-runtime-binding.json")
        self.cursorAcpRuntimeBindingURL = cursorAcpRuntimeBindingURL
            ?? clientRoot.appendingPathComponent("cursor-acp-runtime-binding.json")
        self.isDedicatedHeadlessDrainLoaded = isDedicatedHeadlessDrainLoaded ?? Self.probeDedicatedHeadlessDrain
        self.isDedicatedCursorAcpDrainLoaded = isDedicatedCursorAcpDrainLoaded ?? Self.probeDedicatedCursorAcpDrain
        self.parentEnvironment = parentEnvironment
    }

    private static func probeDedicatedHeadlessDrain(_ profile: String) -> Bool {
        let uid = getuid()
        let label = "dev.thetriangle.codex-headless-drain.\(profile)"
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        process.arguments = ["print", "gui/\(uid)/\(label)"]
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
            process.waitUntilExit()
            return process.terminationStatus == 0
        } catch {
            return false
        }
    }

    private static func probeDedicatedCursorAcpDrain(_ profile: String) -> Bool {
        let uid = getuid()
        let label = "dev.thetriangle.cursor-acp-drain.\(profile)"
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        process.arguments = ["print", "gui/\(uid)/\(label)"]
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
            process.waitUntilExit()
            return process.terminationStatus == 0
        } catch {
            return false
        }
    }

    public func prepareEnabledInstances() async throws -> PreparedClientSupervisorLaunch {
        let allInstances: [ClientInstance]
        do {
            allInstances = try instanceStore.list()
        } catch {
            throw ClientSupervisorError.invalidInstances
        }
        let deliveryOmissions = allInstances.compactMap { instance -> OmittedClientSupervisorInstance? in
            guard instance.enabled else { return nil }
            switch instance.deliveryMode {
            case .mcpInteractive:
                // Recorded as omitted from worker/eventWake; may still feed appServerWake.
                return .init(instanceID: instance.instanceID.value, reasonCode: "delivery_mode_mcp_interactive")
            case .grokBot:
                // Recorded as omitted from worker/eventWake; may still feed grokBotWake.
                return .init(instanceID: instance.instanceID.value, reasonCode: "delivery_mode_grok_bot")
            case .headlessAppServer:
                // Recorded as omitted from worker/eventWake; may still feed headlessWake.
                return .init(instanceID: instance.instanceID.value, reasonCode: "delivery_mode_headless_app_server")
            case .headlessCursorAcp:
                // Recorded as omitted from worker/eventWake; may still feed cursorAcpWakes.
                return .init(instanceID: instance.instanceID.value, reasonCode: "delivery_mode_headless_cursor_acp")
            case .eventDriven, .worker:
                return nil
            }
        }
        let workers = allInstances.filter(\.participatesInWorkerPolling)
        let wakeMembers = allInstances.filter(\.participatesInEventDrivenWake)
        let appServerMembers = allInstances.filter(\.participatesInAppServerWake)
        let grokBotMembers = allInstances.filter(\.participatesInGrokBotWake)
        let headlessMembers = allInstances.filter(\.participatesInHeadlessWake)
        let cursorAcpMembers = allInstances.filter(\.participatesInCursorAcpWake)
        guard (!workers.isEmpty || !wakeMembers.isEmpty || !appServerMembers.isEmpty || !grokBotMembers.isEmpty || !headlessMembers.isEmpty || !cursorAcpMembers.isEmpty),
              Set(workers.map(\.profile)).count == workers.count,
              Set(wakeMembers.map(\.profile)).count == wakeMembers.count,
              Set(appServerMembers.map(\.profile)).count == appServerMembers.count,
              Set(grokBotMembers.map(\.profile)).count == grokBotMembers.count,
              Set(headlessMembers.map(\.profile)).count == headlessMembers.count,
              Set(cursorAcpMembers.map(\.profile)).count == cursorAcpMembers.count,
              workers.allSatisfy({ $0.instanceID == .derive(profile: $0.profile) }),
              wakeMembers.allSatisfy({ $0.instanceID == .derive(profile: $0.profile) }),
              appServerMembers.allSatisfy({ $0.instanceID == .derive(profile: $0.profile) }),
              grokBotMembers.allSatisfy({ $0.instanceID == .derive(profile: $0.profile) }),
              headlessMembers.allSatisfy({ $0.instanceID == .derive(profile: $0.profile) }),
              cursorAcpMembers.allSatisfy({ $0.instanceID == .derive(profile: $0.profile) })
        else { throw ClientSupervisorError.noEligibleInstances }

        // This entire resolution phase deliberately precedes the first
        // credential lookup. A damaged or downgraded runtime cannot cause
        // Keychain material to be released.
        var runtimeOmissions: [OmittedClientSupervisorInstance] = []
        var resolved: [(instance: ClientInstance, command: WorkerCommand)] = []
        for instance in workers {
            do {
                let command = try resolver.resolveAdapter(for: instance)
                try validateAdapterBeforeCredential(command, instance: instance)
                resolved.append((instance, command))
            } catch {
                runtimeOmissions.append(.init(instanceID: instance.instanceID.value, reasonCode: "runtime_ineligible"))
            }
        }

        let coordinatorSources: [ClientInstance]
        if !resolved.isEmpty {
            coordinatorSources = resolved.map(\.instance)
        } else if !wakeMembers.isEmpty {
            coordinatorSources = wakeMembers
        } else if !appServerMembers.isEmpty {
            coordinatorSources = appServerMembers
        } else if !headlessMembers.isEmpty {
            coordinatorSources = headlessMembers
        } else if !cursorAcpMembers.isEmpty {
            coordinatorSources = cursorAcpMembers
        } else {
            coordinatorSources = grokBotMembers
        }
        guard !coordinatorSources.isEmpty else { throw ClientSupervisorError.noEligibleInstances }
        let coordinator: WorkerCommand
        do {
            let resolvedCoordinator = try resolver.resolveCoordinator(for: coordinatorSources)
            let optIn = Self.productionOptInEnvironment(from: parentEnvironment)
            let coordinatorEnvironment = resolvedCoordinator.environment.merging(optIn) { _, forwarded in forwarded }
            coordinator = WorkerCommand(
                executable: resolvedCoordinator.executable,
                arguments: resolvedCoordinator.arguments,
                workingDirectory: resolvedCoordinator.workingDirectory,
                environment: coordinatorEnvironment
            )
            try validateCoordinator(coordinator)
        } catch {
            throw ClientSupervisorError.runtimeUnavailable
        }

        var prepared: [PreparedBootstrapInstance] = []
        var publicInstances: [PreparedClientSupervisorInstance] = []
        var omitted = deliveryOmissions + runtimeOmissions
        for (instance, command) in resolved {
            let credential: VerifiedCredential
            do {
                credential = try await gate.credential(for: instance.profile)
            } catch {
                omitted.append(.init(instanceID: instance.instanceID.value, reasonCode: "credential_ineligible"))
                continue
            }
            try validateAdapterSecretConfinement(command, credential: credential)
            let workloadRecord = try? workloadKeyStore.read(for: instance.profile)
            prepared.append(PreparedBootstrapInstance(
                instanceId: instance.instanceID.value,
                mailbox: PreparedBootstrapMailbox(
                    meshUrl: credential.origin.value,
                    meshToken: credential.binding.token.secretValue,
                    recipientId: credential.agentID.value,
                    pageLimit: 1,
                    workloadId: workloadRecord?.workloadID?.value,
                    workloadPrivateKey: workloadRecord?.privateKey.rawRepresentation.base64EncodedString()
                ),
                runner: PreparedBootstrapRunner(
                    command: command.executable.path,
                    args: command.arguments,
                    timeoutMs: Self.maximumRunnerTimeoutMilliseconds
                ),
                runnerEnvironment: command.environment
            ))
            publicInstances.append(.init(instanceID: instance.instanceID.value, runtimeAdapter: instance.runtimeAdapter))
        }
        if !prepared.isEmpty {
            guard Set(prepared.map(\.mailbox.meshToken)).count == prepared.count else {
                throw ClientSupervisorError.invalidBootstrap
            }
        }

        let eventWake: PreparedEventWakeBootstrap?
        do {
            eventWake = try await prepareEventWake(wakeMembers: wakeMembers, omitted: &omitted)
        } catch let error as ClientSupervisorError {
            throw error
        } catch {
            throw ClientSupervisorError.invalidBootstrap
        }

        let appServerWake: PreparedAppServerWakeBootstrap?
        do {
            appServerWake = try await prepareAppServerWake(members: appServerMembers, omitted: &omitted)
        } catch let error as ClientSupervisorError {
            throw error
        } catch {
            throw ClientSupervisorError.invalidBootstrap
        }

        let grokBotWake: PreparedGrokBotWakeBootstrap?
        do {
            grokBotWake = try await prepareGrokBotWake(members: grokBotMembers, omitted: &omitted)
        } catch let error as ClientSupervisorError {
            throw error
        } catch {
            throw ClientSupervisorError.invalidBootstrap
        }

        let headlessWakes: [PreparedHeadlessWakeBootstrap]
        do {
            headlessWakes = try await prepareHeadlessWakes(members: headlessMembers, omitted: &omitted)
        } catch let error as ClientSupervisorError {
            throw error
        } catch {
            throw ClientSupervisorError.invalidBootstrap
        }

        let cursorAcpWakes: [PreparedCursorAcpWakeBootstrap]
        do {
            cursorAcpWakes = try await prepareCursorAcpWakes(members: cursorAcpMembers, omitted: &omitted)
        } catch let error as ClientSupervisorError {
            throw error
        } catch {
            throw ClientSupervisorError.invalidBootstrap
        }

        guard !prepared.isEmpty || eventWake != nil || appServerWake != nil || grokBotWake != nil || !headlessWakes.isEmpty || !cursorAcpWakes.isEmpty else {
            throw ClientSupervisorError.noEligibleInstances
        }

        if let appServerWake, let eventWake {
            let wakeIds = Set(eventWake.profiles.map(\.instanceId))
            guard !wakeIds.contains(appServerWake.binding.instanceId) else {
                throw ClientSupervisorError.invalidBootstrap
            }
        }
        if let appServerWake {
            let workerIds = Set(prepared.map(\.instanceId))
            guard !workerIds.contains(appServerWake.binding.instanceId) else {
                throw ClientSupervisorError.invalidBootstrap
            }
        }
        if let grokBotWake, let eventWake {
            let wakeIds = Set(eventWake.profiles.map(\.instanceId))
            guard !wakeIds.contains(grokBotWake.binding.instanceId) else {
                throw ClientSupervisorError.invalidBootstrap
            }
        }
        if let grokBotWake {
            let workerIds = Set(prepared.map(\.instanceId))
            guard !workerIds.contains(grokBotWake.binding.instanceId) else {
                throw ClientSupervisorError.invalidBootstrap
            }
        }
        if let grokBotWake, let appServerWake {
            guard grokBotWake.binding.instanceId != appServerWake.binding.instanceId else {
                throw ClientSupervisorError.invalidBootstrap
            }
        }
        for headlessWake in headlessWakes {
            let workerIds = Set(prepared.map(\.instanceId))
            let wakeIds = Set(eventWake?.profiles.map(\.instanceId) ?? [])
            guard !workerIds.contains(headlessWake.profileInstanceId),
                  !wakeIds.contains(headlessWake.profileInstanceId),
                  appServerWake?.binding.instanceId != headlessWake.profileInstanceId,
                  grokBotWake?.binding.instanceId != headlessWake.profileInstanceId
            else {
                throw ClientSupervisorError.invalidBootstrap
            }
        }
        for cursorAcpWake in cursorAcpWakes {
            let workerIds = Set(prepared.map(\.instanceId))
            let wakeIds = Set(eventWake?.profiles.map(\.instanceId) ?? [])
            let headlessIds = Set(headlessWakes.map(\.profileInstanceId))
            guard !workerIds.contains(cursorAcpWake.profileInstanceId),
                  !wakeIds.contains(cursorAcpWake.profileInstanceId),
                  !headlessIds.contains(cursorAcpWake.profileInstanceId),
                  appServerWake?.binding.instanceId != cursorAcpWake.profileInstanceId,
                  grokBotWake?.binding.instanceId != cursorAcpWake.profileInstanceId
            else {
                throw ClientSupervisorError.invalidBootstrap
            }
        }

        var allMailboxTokens = prepared.map(\.mailbox.meshToken)
        if let eventWake {
            allMailboxTokens.append(contentsOf: eventWake.drains.map(\.mailbox.meshToken))
        }
        guard Set(allMailboxTokens).count == allMailboxTokens.count else {
            throw ClientSupervisorError.invalidBootstrap
        }

        let document = PreparedBootstrap(
            version: 1,
            maxConcurrentReasoners: 2,
            instances: prepared,
            eventWake: eventWake,
            appServerWake: appServerWake,
            grokBotWake: grokBotWake,
            headlessWakes: headlessWakes,
            cursorAcpWakes: cursorAcpWakes
        )
        let data: Data
        do {
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.sortedKeys]
            data = try encoder.encode(document)
        } catch {
            throw ClientSupervisorError.invalidBootstrap
        }
        guard data.count <= Self.maximumBootstrapBytes else { throw ClientSupervisorError.invalidBootstrap }
        return PreparedClientSupervisorLaunch(
            instances: publicInstances,
            eventWakeProfileCount: eventWake?.profiles.count ?? 0,
            omitted: omitted,
            command: coordinator,
            bootstrap: data
        )
    }

    private func prepareEventWake(
        wakeMembers: [ClientInstance],
        omitted: inout [OmittedClientSupervisorInstance]
    ) async throws -> PreparedEventWakeBootstrap? {
        guard !wakeMembers.isEmpty else { return nil }
        guard helperExecutableURL.path.hasPrefix("/"),
              FileManager.default.isExecutableFile(atPath: helperExecutableURL.path)
        else { throw ClientSupervisorError.runtimeUnavailable }
        guard wakeCursorURL.path.hasPrefix("/") else { throw ClientSupervisorError.invalidBootstrap }

        let installationID: InstallationID
        do {
            installationID = try installationIdentity.resolve()
        } catch {
            throw ClientSupervisorError.runtimeUnavailable
        }

        var profiles: [PreparedEventWakeProfile] = []
        var drains: [PreparedBootstrapInstance] = []
        for instance in wakeMembers.sorted(by: { $0.profile.value < $1.profile.value }) {
            let command: WorkerCommand
            do {
                command = try resolver.resolveAdapter(for: instance)
                try validateAdapterBeforeCredential(command, instance: instance)
            } catch {
                omitted.append(.init(instanceID: instance.instanceID.value, reasonCode: "runtime_ineligible"))
                continue
            }
            let credential: VerifiedCredential
            do {
                credential = try await gate.credential(for: instance.profile)
            } catch {
                omitted.append(.init(instanceID: instance.instanceID.value, reasonCode: "credential_ineligible"))
                continue
            }
            try validateAdapterSecretConfinement(command, credential: credential)
            let workloadRecord = try? workloadKeyStore.read(for: instance.profile)
            profiles.append(PreparedEventWakeProfile(
                instanceId: instance.instanceID.value,
                agentId: credential.agentID.value
            ))
            drains.append(PreparedBootstrapInstance(
                instanceId: instance.instanceID.value,
                mailbox: PreparedBootstrapMailbox(
                    meshUrl: credential.origin.value,
                    meshToken: credential.binding.token.secretValue,
                    recipientId: credential.agentID.value,
                    pageLimit: 1,
                    workloadId: workloadRecord?.workloadID?.value,
                    workloadPrivateKey: workloadRecord?.privateKey.rawRepresentation.base64EncodedString()
                ),
                runner: PreparedBootstrapRunner(
                    command: command.executable.path,
                    args: command.arguments,
                    timeoutMs: Self.maximumRunnerTimeoutMilliseconds
                ),
                runnerEnvironment: command.environment
            ))
        }
        guard !profiles.isEmpty, profiles.count == drains.count else {
            throw ClientSupervisorError.noEligibleInstances
        }
        let actorProfile = wakeMembers
            .filter { member in profiles.contains { $0.instanceId == member.instanceID.value } }
            .map(\.profile.value)
            .sorted()
            .first
        guard let actorProfile else { throw ClientSupervisorError.noEligibleInstances }
        return PreparedEventWakeBootstrap(
            installationId: installationID.value,
            helperPath: helperExecutableURL.path,
            cursorPath: wakeCursorURL.path,
            actorProfile: actorProfile,
            ensureBeforeWatch: true,
            profiles: profiles,
            drains: drains
        )
    }

    private func prepareAppServerWake(
        members: [ClientInstance],
        omitted: inout [OmittedClientSupervisorInstance]
    ) async throws -> PreparedAppServerWakeBootstrap? {
        guard !members.isEmpty else { return nil }
        guard helperExecutableURL.path.hasPrefix("/"),
              FileManager.default.isExecutableFile(atPath: helperExecutableURL.path)
        else { throw ClientSupervisorError.runtimeUnavailable }
        guard appServerBindingURL.path.hasPrefix("/"),
              appServerWakeCursorURL.path.hasPrefix("/"),
              appServerAuthTokenURL.path.hasPrefix("/")
        else { throw ClientSupervisorError.invalidBootstrap }

        // Binding file is operator-provisioned (shared App Server keep-alive). Absent → skip.
        guard FileManager.default.isReadableFile(atPath: appServerBindingURL.path),
              FileManager.default.isReadableFile(atPath: appServerAuthTokenURL.path)
        else {
            for instance in members {
                omitted.append(.init(
                    instanceID: instance.instanceID.value,
                    reasonCode: "app_server_binding_missing"
                ))
            }
            return nil
        }

        let installationID: InstallationID
        do {
            installationID = try installationIdentity.resolve()
        } catch {
            throw ClientSupervisorError.runtimeUnavailable
        }

        let bindingData: Data
        do {
            bindingData = try Data(contentsOf: appServerBindingURL)
        } catch {
            throw ClientSupervisorError.invalidBootstrap
        }
        guard let object = try JSONSerialization.jsonObject(with: bindingData) as? [String: Any] else {
            throw ClientSupervisorError.invalidBootstrap
        }

        let sortedMembers = members.sorted(by: { $0.profile.value < $1.profile.value })
        let bindingInstanceIdHint = object["instanceId"] as? String
        let matched = sortedMembers.first(where: { $0.instanceID.value == bindingInstanceIdHint })
        guard let primary = matched ?? (sortedMembers.count == 1 ? sortedMembers.first : nil) else {
            for instance in sortedMembers {
                omitted.append(.init(
                    instanceID: instance.instanceID.value,
                    reasonCode: "app_server_binding_mismatch"
                ))
            }
            return nil
        }
        let credential: VerifiedCredential
        do {
            credential = try await gate.credential(for: primary.profile)
        } catch {
            omitted.append(.init(instanceID: primary.instanceID.value, reasonCode: "credential_ineligible"))
            return nil
        }

        let bindingInstanceId = object["instanceId"] as? String
        let bindingAgentId = object["agentId"] as? String
        let bindingInstallationId = object["installationId"] as? String
        guard bindingInstanceId == primary.instanceID.value,
              bindingAgentId == credential.agentID.value,
              bindingInstallationId == installationID.value
        else {
            omitted.append(.init(instanceID: primary.instanceID.value, reasonCode: "app_server_binding_mismatch"))
            return nil
        }

        guard let adapterVersion = object["adapterVersion"] as? String,
              adapterVersion == "1",
              object["enabled"] as? Bool == true,
              let roomScope = object["roomScope"] as? String,
              let serverIdentity = object["serverIdentity"] as? String,
              let endpoint = object["endpoint"] as? String,
              let threadId = object["threadId"] as? String,
              endpoint.hasPrefix("ws://") || endpoint.hasPrefix("wss://"),
              !serverIdentity.isEmpty,
              !threadId.isEmpty,
              !roomScope.isEmpty
        else {
            throw ClientSupervisorError.invalidBootstrap
        }

        return PreparedAppServerWakeBootstrap(
            installationId: installationID.value,
            helperPath: helperExecutableURL.path,
            cursorPath: appServerWakeCursorURL.path,
            bindingPath: appServerBindingURL.path,
            actorProfile: primary.profile.value,
            ensureBeforeWatch: true,
            authTokenFile: appServerAuthTokenURL.path,
            authTokenEnv: nil,
            binding: PreparedAppServerBinding(
                adapterVersion: adapterVersion,
                enabled: true,
                installationId: installationID.value,
                instanceId: primary.instanceID.value,
                agentId: credential.agentID.value,
                roomScope: roomScope,
                serverIdentity: serverIdentity,
                endpoint: endpoint,
                threadId: threadId
            )
        )
    }

    private func prepareGrokBotWake(
        members: [ClientInstance],
        omitted: inout [OmittedClientSupervisorInstance]
    ) async throws -> PreparedGrokBotWakeBootstrap? {
        guard !members.isEmpty else { return nil }
        guard helperExecutableURL.path.hasPrefix("/"),
              FileManager.default.isExecutableFile(atPath: helperExecutableURL.path)
        else { throw ClientSupervisorError.runtimeUnavailable }
        guard grokBotBindingURL.path.hasPrefix("/"),
              grokBotWakeCursorURL.path.hasPrefix("/"),
              grokBotWebhookURLPath.path.hasPrefix("/"),
              grokBotWebhookKeyPath.path.hasPrefix("/")
        else { throw ClientSupervisorError.invalidBootstrap }

        // Binding + webhook files are operator-provisioned. Absent → skip.
        guard FileManager.default.isReadableFile(atPath: grokBotBindingURL.path),
              FileManager.default.isReadableFile(atPath: grokBotWebhookURLPath.path),
              FileManager.default.isReadableFile(atPath: grokBotWebhookKeyPath.path)
        else {
            for instance in members {
                omitted.append(.init(
                    instanceID: instance.instanceID.value,
                    reasonCode: "grok_bot_binding_missing"
                ))
            }
            return nil
        }

        let installationID: InstallationID
        do {
            installationID = try installationIdentity.resolve()
        } catch {
            throw ClientSupervisorError.runtimeUnavailable
        }

        let bindingData: Data
        do {
            bindingData = try Data(contentsOf: grokBotBindingURL)
        } catch {
            throw ClientSupervisorError.invalidBootstrap
        }
        guard let object = try JSONSerialization.jsonObject(with: bindingData) as? [String: Any] else {
            throw ClientSupervisorError.invalidBootstrap
        }

        let sortedMembers = members.sorted(by: { $0.profile.value < $1.profile.value })
        let bindingInstanceIdHint = object["instanceId"] as? String
        let matched = sortedMembers.first(where: { $0.instanceID.value == bindingInstanceIdHint })
        guard let primary = matched ?? (sortedMembers.count == 1 ? sortedMembers.first : nil) else {
            for instance in sortedMembers {
                omitted.append(.init(
                    instanceID: instance.instanceID.value,
                    reasonCode: "grok_bot_binding_mismatch"
                ))
            }
            return nil
        }
        let credential: VerifiedCredential
        do {
            credential = try await gate.credential(for: primary.profile)
        } catch {
            omitted.append(.init(instanceID: primary.instanceID.value, reasonCode: "credential_ineligible"))
            return nil
        }

        let bindingInstanceId = object["instanceId"] as? String
        let bindingAgentId = object["agentId"] as? String
        let bindingInstallationId = object["installationId"] as? String
        let bindingProfile = object["profile"] as? String
        guard bindingInstanceId == primary.instanceID.value,
              bindingAgentId == credential.agentID.value,
              bindingInstallationId == installationID.value,
              bindingProfile == primary.profile.value
        else {
            omitted.append(.init(instanceID: primary.instanceID.value, reasonCode: "grok_bot_binding_mismatch"))
            return nil
        }

        guard let adapterVersion = object["adapterVersion"] as? String,
              adapterVersion == "1",
              object["enabled"] as? Bool == true,
              let grokAgentId = object["grokAgentId"] as? String,
              !grokAgentId.isEmpty,
              let wakeMode = object["wakeMode"] as? String,
              wakeMode == "webhook"
        else {
            throw ClientSupervisorError.invalidBootstrap
        }

        return PreparedGrokBotWakeBootstrap(
            installationId: installationID.value,
            helperPath: helperExecutableURL.path,
            cursorPath: grokBotWakeCursorURL.path,
            bindingPath: grokBotBindingURL.path,
            webhookUrlPath: grokBotWebhookURLPath.path,
            webhookKeyPath: grokBotWebhookKeyPath.path,
            actorProfile: primary.profile.value,
            ensureBeforeWatch: true,
            binding: PreparedGrokBotBinding(
                adapterVersion: adapterVersion,
                enabled: true,
                installationId: installationID.value,
                instanceId: primary.instanceID.value,
                agentId: credential.agentID.value,
                profile: primary.profile.value,
                grokAgentId: grokAgentId,
                wakeMode: wakeMode
            )
        )
    }

    private func prepareHeadlessWakes(
        members: [ClientInstance],
        omitted: inout [OmittedClientSupervisorInstance]
    ) async throws -> [PreparedHeadlessWakeBootstrap] {
        guard !members.isEmpty else { return [] }
        guard helperExecutableURL.path.hasPrefix("/"),
              FileManager.default.isExecutableFile(atPath: helperExecutableURL.path)
        else { throw ClientSupervisorError.runtimeUnavailable }
        guard headlessRuntimeBindingURL.path.hasPrefix("/") else { throw ClientSupervisorError.invalidBootstrap }

        guard FileManager.default.isReadableFile(atPath: headlessRuntimeBindingURL.path) else {
            for instance in members {
                omitted.append(.init(
                    instanceID: instance.instanceID.value,
                    reasonCode: "headless_runtime_binding_missing"
                ))
            }
            return []
        }

        let bindingData: Data
        do {
            bindingData = try Data(contentsOf: headlessRuntimeBindingURL)
        } catch {
            throw ClientSupervisorError.invalidBootstrap
        }
        guard let object = try JSONSerialization.jsonObject(with: bindingData) as? [String: Any] else {
            throw ClientSupervisorError.invalidBootstrap
        }

        let installationID: InstallationID
        do {
            installationID = try installationIdentity.resolve()
        } catch {
            throw ClientSupervisorError.runtimeUnavailable
        }

        let topLevelKeys: Set<String> = ["version", "common", "profiles"]
        let commonKeys: Set<String> = ["adapterVersion", "installationId", "workingDirectory", "codexHome", "command", "pollIntervalMs"]
        let profileKeys: Set<String> = ["profile", "instanceId", "stateRoot"]
        guard Set(object.keys) == topLevelKeys,
              object["version"] as? Int == 2,
              let common = object["common"] as? [String: Any],
              Set(common.keys) == commonKeys,
              let profileObjects = object["profiles"] as? [[String: Any]],
              !profileObjects.isEmpty,
              profileObjects.count <= 100,
              profileObjects.allSatisfy({ Set($0.keys) == profileKeys })
        else { throw ClientSupervisorError.invalidBootstrap }

        let pollIntervalMs: Int
        if let number = common["pollIntervalMs"] as? NSNumber,
           number.doubleValue.isFinite,
           number.doubleValue.rounded(.towardZero) == number.doubleValue,
           number.doubleValue >= Double(Int.min),
           number.doubleValue <= Double(Int.max) {
            pollIntervalMs = number.intValue
        } else {
            throw ClientSupervisorError.invalidBootstrap
        }

        guard let adapterVersion = common["adapterVersion"] as? String,
              adapterVersion == "1",
              let bindingInstallationId = common["installationId"] as? String,
              bindingInstallationId == installationID.value,
              let workingDirectory = common["workingDirectory"] as? String,
              workingDirectory.hasPrefix("/"),
              !workingDirectory.contains("\0"),
              let codexHome = common["codexHome"] as? String,
              codexHome.hasPrefix("/"),
              !codexHome.contains("\0"),
              let command = common["command"] as? String,
              command.hasPrefix("/"),
              !command.contains("\0"),
              (100...60_000).contains(pollIntervalMs)
        else { throw ClientSupervisorError.invalidBootstrap }

        struct BindingEntry {
            let profile: String
            let instanceId: String
            let stateRoot: String
        }
        func containsSymlinkComponent(_ path: String) -> Bool {
            var current = "/"
            for component in (path as NSString).pathComponents.dropFirst() {
                current = (current as NSString).appendingPathComponent(component)
                guard let attributes = try? FileManager.default.attributesOfItem(atPath: current) else {
                    continue // A staged suffix may not exist yet.
                }
                if attributes[.type] as? FileAttributeType == .typeSymbolicLink {
                    return true
                }
            }
            return false
        }
        let entries: [BindingEntry] = try profileObjects.map { entry in
            guard let profile = entry["profile"] as? String,
                  let instanceId = entry["instanceId"] as? String,
                  let stateRoot = entry["stateRoot"] as? String,
                  stateRoot.hasPrefix("/"),
                  !stateRoot.contains("\0")
            else { throw ClientSupervisorError.invalidBootstrap }
            let standardizedStateRoot = URL(fileURLWithPath: stateRoot).standardizedFileURL.path
            guard stateRoot == standardizedStateRoot,
                  !containsSymlinkComponent(standardizedStateRoot)
            else { throw ClientSupervisorError.invalidBootstrap }
            return BindingEntry(profile: profile, instanceId: instanceId, stateRoot: standardizedStateRoot)
        }
        guard Set(entries.map(\.profile)).count == entries.count,
              Set(entries.map(\.instanceId)).count == entries.count,
              Set(entries.map(\.stateRoot)).count == entries.count
        else { throw ClientSupervisorError.invalidBootstrap }

        let sortedMembers = members.sorted(by: { $0.profile.value < $1.profile.value })
        let memberProfiles = Set(sortedMembers.map { $0.profile.value })
        guard entries.allSatisfy({ memberProfiles.contains($0.profile) }) else {
            throw ClientSupervisorError.invalidBootstrap
        }
        var prepared: [PreparedHeadlessWakeBootstrap] = []
        var credentialTokens: Set<String> = []
        var credentialAgentIds: Set<String> = []
        for member in sortedMembers {
            guard member.runtimeAdapter == .codex else {
                omitted.append(.init(instanceID: member.instanceID.value, reasonCode: "grok_bot_not_in_codex_pool"))
                continue
            }
            guard let entry = entries.first(where: { $0.profile == member.profile.value }),
                  entry.instanceId == member.instanceID.value
            else {
                omitted.append(.init(instanceID: member.instanceID.value, reasonCode: "headless_runtime_binding_mismatch"))
                continue
            }
            if isDedicatedHeadlessDrainLoaded(member.profile.value) {
                omitted.append(.init(instanceID: member.instanceID.value, reasonCode: "dedicated_headless_drain_loaded"))
                continue
            }
            let credential: VerifiedCredential
            do {
                credential = try await gate.credential(for: member.profile)
            } catch {
                omitted.append(.init(instanceID: member.instanceID.value, reasonCode: "credential_ineligible"))
                continue
            }
            guard !credential.agentID.value.isEmpty else {
                omitted.append(.init(instanceID: member.instanceID.value, reasonCode: "credential_ineligible"))
                continue
            }
            guard credentialTokens.insert(credential.binding.token.secretValue).inserted,
                  credentialAgentIds.insert(credential.agentID.value).inserted
            else { throw ClientSupervisorError.invalidBootstrap }
            prepared.append(PreparedHeadlessWakeBootstrap(
                profile: member.profile.value,
                profileInstanceId: member.instanceID.value,
                helperPath: helperExecutableURL.path,
                allowedRoomId: nil,
                workingDirectory: workingDirectory,
                codexHome: codexHome,
                stateRoot: entry.stateRoot,
                command: command,
                pollIntervalMs: pollIntervalMs
            ))
        }
        return prepared
    }

    private func prepareCursorAcpWakes(
        members: [ClientInstance],
        omitted: inout [OmittedClientSupervisorInstance]
    ) async throws -> [PreparedCursorAcpWakeBootstrap] {
        guard !members.isEmpty else { return [] }
        guard helperExecutableURL.path.hasPrefix("/"),
              FileManager.default.isExecutableFile(atPath: helperExecutableURL.path)
        else { throw ClientSupervisorError.runtimeUnavailable }
        guard cursorAcpRuntimeBindingURL.path.hasPrefix("/") else { throw ClientSupervisorError.invalidBootstrap }

        guard FileManager.default.isReadableFile(atPath: cursorAcpRuntimeBindingURL.path) else {
            for instance in members {
                omitted.append(.init(
                    instanceID: instance.instanceID.value,
                    reasonCode: "cursor_acp_runtime_binding_missing"
                ))
            }
            return []
        }

        let bindingData: Data
        do {
            bindingData = try Data(contentsOf: cursorAcpRuntimeBindingURL)
        } catch {
            throw ClientSupervisorError.invalidBootstrap
        }
        guard let object = try JSONSerialization.jsonObject(with: bindingData) as? [String: Any] else {
            throw ClientSupervisorError.invalidBootstrap
        }

        let installationID: InstallationID
        do {
            installationID = try installationIdentity.resolve()
        } catch {
            throw ClientSupervisorError.runtimeUnavailable
        }

        let topLevelKeys: Set<String> = ["version", "common", "profiles"]
        let commonKeys: Set<String> = ["adapterVersion", "installationId", "workingDirectory", "cursorHome", "command", "pollIntervalMs"]
        let profileKeys: Set<String> = ["profile", "instanceId", "stateRoot", "shadowTestProfile"]
        guard Set(object.keys) == topLevelKeys,
              object["version"] as? Int == 1,
              let common = object["common"] as? [String: Any],
              Set(common.keys) == commonKeys,
              let profileObjects = object["profiles"] as? [[String: Any]],
              !profileObjects.isEmpty,
              profileObjects.count <= 100,
              profileObjects.allSatisfy({ Set($0.keys) == profileKeys })
        else { throw ClientSupervisorError.invalidBootstrap }

        let pollIntervalMs: Int
        if let number = common["pollIntervalMs"] as? NSNumber,
           number.doubleValue.isFinite,
           number.doubleValue.rounded(.towardZero) == number.doubleValue,
           number.doubleValue >= Double(Int.min),
           number.doubleValue <= Double(Int.max) {
            pollIntervalMs = number.intValue
        } else {
            throw ClientSupervisorError.invalidBootstrap
        }

        guard let adapterVersion = common["adapterVersion"] as? String,
              adapterVersion == "1",
              let bindingInstallationId = common["installationId"] as? String,
              bindingInstallationId == installationID.value,
              let workingDirectory = common["workingDirectory"] as? String,
              workingDirectory.hasPrefix("/"),
              !workingDirectory.contains("\0"),
              let cursorHome = common["cursorHome"] as? String,
              cursorHome.hasPrefix("/"),
              !cursorHome.contains("\0"),
              let command = common["command"] as? String,
              command.hasPrefix("/"),
              !command.contains("\0"),
              (100...60_000).contains(pollIntervalMs)
        else { throw ClientSupervisorError.invalidBootstrap }

        struct BindingEntry {
            let profile: String
            let instanceId: String
            let stateRoot: String
            let shadowTestProfile: Bool
        }
        func containsSymlinkComponent(_ path: String) -> Bool {
            var current = "/"
            for component in (path as NSString).pathComponents.dropFirst() {
                current = (current as NSString).appendingPathComponent(component)
                guard let attributes = try? FileManager.default.attributesOfItem(atPath: current) else {
                    continue
                }
                if attributes[.type] as? FileAttributeType == .typeSymbolicLink {
                    return true
                }
            }
            return false
        }
        let entries: [BindingEntry] = try profileObjects.map { entry in
            guard let profile = entry["profile"] as? String,
                  let instanceId = entry["instanceId"] as? String,
                  let stateRoot = entry["stateRoot"] as? String,
                  let shadowTestProfile = entry["shadowTestProfile"] as? Bool,
                  stateRoot.hasPrefix("/"),
                  !stateRoot.contains("\0")
            else { throw ClientSupervisorError.invalidBootstrap }
            let standardizedStateRoot = URL(fileURLWithPath: stateRoot).standardizedFileURL.path
            guard stateRoot == standardizedStateRoot,
                  !containsSymlinkComponent(standardizedStateRoot)
            else { throw ClientSupervisorError.invalidBootstrap }
            return BindingEntry(
                profile: profile,
                instanceId: instanceId,
                stateRoot: standardizedStateRoot,
                shadowTestProfile: shadowTestProfile
            )
        }
        guard Set(entries.map(\.profile)).count == entries.count,
              Set(entries.map(\.instanceId)).count == entries.count,
              Set(entries.map(\.stateRoot)).count == entries.count
        else { throw ClientSupervisorError.invalidBootstrap }

        let sortedMembers = members.sorted(by: { $0.profile.value < $1.profile.value })
        let memberProfiles = Set(sortedMembers.map { $0.profile.value })
        guard entries.allSatisfy({ memberProfiles.contains($0.profile) }) else {
            throw ClientSupervisorError.invalidBootstrap
        }
        var prepared: [PreparedCursorAcpWakeBootstrap] = []
        var credentialTokens: Set<String> = []
        var credentialAgentIds: Set<String> = []
        for member in sortedMembers {
            guard member.runtimeAdapter == .cursorAcp else {
                omitted.append(.init(instanceID: member.instanceID.value, reasonCode: "cursor_acp_adapter_mismatch"))
                continue
            }
            guard let entry = entries.first(where: { $0.profile == member.profile.value }),
                  entry.instanceId == member.instanceID.value
            else {
                omitted.append(.init(instanceID: member.instanceID.value, reasonCode: "cursor_acp_runtime_binding_mismatch"))
                continue
            }
            guard entry.shadowTestProfile else {
                omitted.append(.init(instanceID: member.instanceID.value, reasonCode: "cursor_acp_not_shadow_test_profile"))
                continue
            }
            if isDedicatedCursorAcpDrainLoaded(member.profile.value) {
                omitted.append(.init(instanceID: member.instanceID.value, reasonCode: "dedicated_cursor_acp_drain_loaded"))
                continue
            }
            if isDedicatedHeadlessDrainLoaded(member.profile.value) {
                omitted.append(.init(instanceID: member.instanceID.value, reasonCode: "codex_drain_blocks_cursor_acp"))
                continue
            }
            let credential: VerifiedCredential
            do {
                credential = try await gate.credential(for: member.profile)
            } catch {
                omitted.append(.init(instanceID: member.instanceID.value, reasonCode: "credential_ineligible"))
                continue
            }
            guard !credential.agentID.value.isEmpty else {
                omitted.append(.init(instanceID: member.instanceID.value, reasonCode: "credential_ineligible"))
                continue
            }
            guard credentialTokens.insert(credential.binding.token.secretValue).inserted,
                  credentialAgentIds.insert(credential.agentID.value).inserted
            else { throw ClientSupervisorError.invalidBootstrap }
            prepared.append(PreparedCursorAcpWakeBootstrap(
                profile: member.profile.value,
                profileInstanceId: member.instanceID.value,
                helperPath: helperExecutableURL.path,
                workingDirectory: workingDirectory,
                cursorHome: cursorHome,
                stateRoot: entry.stateRoot,
                command: command,
                pollIntervalMs: pollIntervalMs,
                shadowTestProfile: true
            ))
        }
        return prepared
    }

    public func run() async throws {
        let launch = try await prepareEnabledInstances()
        let request = ClientSupervisorProcessRequest(
            executable: launch.command.executable,
            arguments: launch.command.arguments,
            workingDirectory: launch.command.workingDirectory,
            environment: launch.command.environment
        )
        let status: Int32
        do { status = try await processRunner.run(request, standardInput: launch.bootstrap) }
        catch { throw ClientSupervisorError.processFailed }
        guard status == 0 else { throw ClientSupervisorError.processFailed }
    }

    public func preflight() async throws {
        let launch = try await prepareEnabledInstances()
        guard !launch.omitted.contains(where: { !$0.reasonCode.hasPrefix("delivery_mode_") }) else {
            throw ClientSupervisorError.invalidBootstrap
        }
    }

    private func validateCoordinator(_ command: WorkerCommand) throws {
        guard command.executable.path.hasPrefix("/"),
              command.arguments.count == 1,
              command.arguments[0].hasSuffix("/packages/agent-worker/src/client-supervisor-cli.mjs") || command.arguments[0] == "/trusted/client-supervisor-cli.mjs",
              command.arguments.allSatisfy({ !$0.contains("\0") && !$0.hasPrefix("--") }),
              Set(command.environment.keys).isSubset(of: Self.coordinatorEnvironmentKeys),
              !command.environment.isEmpty,
              command.environment.values.allSatisfy({ !$0.contains("\0") && !$0.contains("\n") && !$0.contains("\r") })
        else { throw ClientSupervisorError.runtimeUnavailable }
    }

    private func validateAdapterBeforeCredential(_ command: WorkerCommand, instance: ClientInstance) throws {
        let forbiddenKeys = command.environment.keys.contains { key in
            key.hasPrefix("MESH_") || key.hasSuffix("_AGENT_ID")
        }
        guard !forbiddenKeys,
              command.executable.path.hasPrefix("/"),
              command.workingDirectory.path.hasPrefix("/"),
              command.environment["TRIANGLE_INSTANCE_ID"] == instance.instanceID.value,
              command.arguments.count == 1,
              command.arguments[0].hasSuffix("/\(instance.runtimeAdapter.rawValue)-runner.mjs"),
              ([command.executable.path, command.workingDirectory.path] + command.arguments + command.environment.keys + command.environment.values)
                .allSatisfy({ !$0.contains("\0") && !$0.contains("\n") && !$0.contains("\r") })
        else { throw ClientSupervisorError.invalidBootstrap }
    }

    private func validateAdapterSecretConfinement(_ command: WorkerCommand, credential: VerifiedCredential) throws {
        let secret = credential.binding.token.secretValue
        let outsideValues = [command.executable.path] + command.arguments + command.environment.keys + command.environment.values
        guard !outsideValues.contains(where: { $0.contains(secret) }) else {
            throw ClientSupervisorError.invalidBootstrap
        }
    }
}

private struct PreparedBootstrap: Encodable {
    let version: Int
    let maxConcurrentReasoners: Int
    let instances: [PreparedBootstrapInstance]
    let eventWake: PreparedEventWakeBootstrap?
    let appServerWake: PreparedAppServerWakeBootstrap?
    let grokBotWake: PreparedGrokBotWakeBootstrap?
    let headlessWakes: [PreparedHeadlessWakeBootstrap]
    let cursorAcpWakes: [PreparedCursorAcpWakeBootstrap]

    private enum CodingKeys: String, CodingKey {
        case version, maxConcurrentReasoners, instances, eventWake, appServerWake, grokBotWake, headlessWakes, cursorAcpWakes
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(version, forKey: .version)
        try container.encode(maxConcurrentReasoners, forKey: .maxConcurrentReasoners)
        try container.encode(instances, forKey: .instances)
        try container.encodeIfPresent(eventWake, forKey: .eventWake)
        try container.encodeIfPresent(appServerWake, forKey: .appServerWake)
        try container.encodeIfPresent(grokBotWake, forKey: .grokBotWake)
        try container.encode(headlessWakes, forKey: .headlessWakes)
        try container.encode(cursorAcpWakes, forKey: .cursorAcpWakes)
    }
}
private struct PreparedBootstrapInstance: Encodable {
    let instanceId: String
    let mailbox: PreparedBootstrapMailbox
    let runner: PreparedBootstrapRunner
    let runnerEnvironment: [String: String]
}
private struct PreparedBootstrapMailbox: Encodable {
    let meshUrl: String
    let meshToken: String
    let recipientId: String
    let pageLimit: Int
    let workloadId: String?
    let workloadPrivateKey: String?
}
private struct PreparedBootstrapRunner: Encodable {
    let command: String
    let args: [String]
    let timeoutMs: Int
}
private struct PreparedEventWakeBootstrap: Encodable {
    let installationId: String
    let helperPath: String
    let cursorPath: String
    let actorProfile: String
    let ensureBeforeWatch: Bool
    let profiles: [PreparedEventWakeProfile]
    let drains: [PreparedBootstrapInstance]
}
private struct PreparedEventWakeProfile: Encodable {
    let instanceId: String
    let agentId: String
}

private struct PreparedAppServerWakeBootstrap: Encodable {
    let installationId: String
    let helperPath: String
    let cursorPath: String
    let bindingPath: String
    let actorProfile: String
    let ensureBeforeWatch: Bool
    let authTokenFile: String?
    let authTokenEnv: String?
    let binding: PreparedAppServerBinding

    private enum CodingKeys: String, CodingKey {
        case installationId, helperPath, cursorPath, bindingPath, actorProfile
        case ensureBeforeWatch, authTokenFile, authTokenEnv, binding
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(installationId, forKey: .installationId)
        try container.encode(helperPath, forKey: .helperPath)
        try container.encode(cursorPath, forKey: .cursorPath)
        try container.encode(bindingPath, forKey: .bindingPath)
        try container.encode(actorProfile, forKey: .actorProfile)
        try container.encode(ensureBeforeWatch, forKey: .ensureBeforeWatch)
        if let authTokenFile {
            try container.encode(authTokenFile, forKey: .authTokenFile)
            try container.encodeNil(forKey: .authTokenEnv)
        } else if let authTokenEnv {
            try container.encodeNil(forKey: .authTokenFile)
            try container.encode(authTokenEnv, forKey: .authTokenEnv)
        } else {
            throw EncodingError.invalidValue(
                self,
                .init(codingPath: container.codingPath, debugDescription: "appServerWake auth missing")
            )
        }
        try container.encode(binding, forKey: .binding)
    }
}

private struct PreparedAppServerBinding: Encodable {
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

private struct PreparedGrokBotWakeBootstrap: Encodable {
    let installationId: String
    let helperPath: String
    let cursorPath: String
    let bindingPath: String
    let webhookUrlPath: String
    let webhookKeyPath: String
    let actorProfile: String
    let ensureBeforeWatch: Bool
    let binding: PreparedGrokBotBinding
}

private struct PreparedGrokBotBinding: Encodable {
    let adapterVersion: String
    let enabled: Bool
    let installationId: String
    let instanceId: String
    let agentId: String
    let profile: String
    let grokAgentId: String
    let wakeMode: String
}

private struct PreparedHeadlessWakeBootstrap: Encodable {
    let profile: String
    let profileInstanceId: String
    let helperPath: String
    let allowedRoomId: String?
    let workingDirectory: String
    let codexHome: String
    let stateRoot: String
    let command: String
    let pollIntervalMs: Int

    private enum CodingKeys: String, CodingKey {
        case profile, profileInstanceId, helperPath, allowedRoomId, workingDirectory, codexHome, stateRoot, command, pollIntervalMs
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(profile, forKey: .profile)
        try container.encode(profileInstanceId, forKey: .profileInstanceId)
        try container.encode(helperPath, forKey: .helperPath)
        try container.encodeIfPresent(allowedRoomId, forKey: .allowedRoomId)
        try container.encode(workingDirectory, forKey: .workingDirectory)
        try container.encode(codexHome, forKey: .codexHome)
        try container.encode(stateRoot, forKey: .stateRoot)
        try container.encode(command, forKey: .command)
        try container.encode(pollIntervalMs, forKey: .pollIntervalMs)
    }
}

private struct PreparedCursorAcpWakeBootstrap: Encodable {
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

public final class FoundationClientSupervisorProcessRunner: ClientSupervisorProcessRunning, @unchecked Sendable {
    private static let processSignalOwnership = NSLock()
    private let inputHandoffTimeoutMilliseconds: Int
    private let terminationGraceMilliseconds: Int
    private let readinessMarkerURL: URL
    private let activationMarkerURL: URL
    private let readinessTimeoutMilliseconds: Int
    private let readinessRequiredOverride: Bool?
    private let parentPID: Int32

    public init(
        inputHandoffTimeoutMilliseconds: Int = 5_000,
        terminationGraceMilliseconds: Int = 250,
        readinessMarkerURL: URL? = nil,
        readinessTimeoutMilliseconds: Int = 10_000,
        readinessRequired: Bool? = nil,
        parentPID: Int32 = getpid()
    ) {
        self.inputHandoffTimeoutMilliseconds = inputHandoffTimeoutMilliseconds
        self.terminationGraceMilliseconds = terminationGraceMilliseconds
        self.readinessMarkerURL = readinessMarkerURL ?? FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/The Triangle/client/ready.json")
        self.activationMarkerURL = self.readinessMarkerURL.deletingLastPathComponent().appendingPathComponent("activate.json")
        self.readinessTimeoutMilliseconds = readinessTimeoutMilliseconds
        self.readinessRequiredOverride = readinessRequired
        self.parentPID = parentPID
    }

    public func run(_ request: ClientSupervisorProcessRequest, standardInput: Data) async throws -> Int32 {
        try Self.processSignalOwnership.withLock {
            try runWithExclusiveSignalOwnership(request, standardInput: standardInput)
        }
    }

    private func runWithExclusiveSignalOwnership(
        _ request: ClientSupervisorProcessRequest,
        standardInput: Data
    ) throws -> Int32 {
        guard standardInput.count <= ClientSupervisor.maximumBootstrapBytes else { throw ClientSupervisorError.invalidBootstrap }
        guard (1...60_000).contains(inputHandoffTimeoutMilliseconds),
              (1...10_000).contains(terminationGraceMilliseconds),
              (1...60_000).contains(readinessTimeoutMilliseconds)
        else {
            throw ClientSupervisorError.processFailed
        }
        let process = Process()
        process.executableURL = request.executable
        process.arguments = request.arguments
        process.currentDirectoryURL = request.workingDirectory
        process.environment = request.environment.merging(["TRIANGLE_ACTIVATION_MARKER_PATH": activationMarkerURL.path]) { _, trusted in trusted }
        let input = Pipe()
        process.standardInput = input
        let readinessRequired = readinessRequiredOverride ?? request.arguments.contains(where: { $0.hasSuffix("/packages/agent-worker/src/client-supervisor-cli.mjs") || $0 == "/trusted/client-supervisor-cli.mjs" })
        let readinessOutput = readinessRequired ? Pipe() : nil
        if let readinessOutput { process.standardOutput = readinessOutput }
        do { try process.run() }
        catch { throw ClientSupervisorError.processFailed }

        let processBox = SupervisorFoundationProcessBox(process)
        let savedActions: SupervisorSavedSignalActions
        do { savedActions = try SupervisorSavedSignalActions.installIgnoring() }
        catch {
            try? input.fileHandleForWriting.close()
            terminateAndReap(processBox)
            throw ClientSupervisorError.processFailed
        }
        let signalQueue = DispatchQueue(label: "dev.thetriangle.client.signals")
        let interrupt = DispatchSource.makeSignalSource(signal: SIGINT, queue: signalQueue)
        let terminate = DispatchSource.makeSignalSource(signal: SIGTERM, queue: signalQueue)
        interrupt.setEventHandler { processBox.forward(SIGINT) }
        terminate.setEventHandler { processBox.forward(SIGTERM) }
        interrupt.resume()
        terminate.resume()
        defer {
            interrupt.cancel()
            terminate.cancel()
            savedActions.restore()
        }

        do {
            try writeBounded(standardInput, to: input.fileHandleForWriting.fileDescriptor, process: processBox)
            try input.fileHandleForWriting.close()
            if let readinessOutput {
                let expectedDigest = SHA256.hash(data: standardInput).map { String(format: "%02x", $0) }.joined()
                let generation = try receiveReadiness(
                    from: readinessOutput.fileHandleForReading.fileDescriptor,
                    process: processBox,
                    expectedDigest: expectedDigest
                )
                try readinessOutput.fileHandleForReading.close()
                try writeReadinessMarker(generation: generation, configDigest: expectedDigest)
                try writeActivationMarker(generation: generation, configDigest: expectedDigest)
            }
        } catch {
            try? input.fileHandleForWriting.close()
            try? readinessOutput?.fileHandleForReading.close()
            terminateAndReap(processBox)
            throw ClientSupervisorError.processFailed
        }
        process.waitUntilExit()
        guard process.terminationReason == .exit, process.terminationStatus == 0 else {
            throw ClientSupervisorError.processFailed
        }
        return 0
    }

    private func receiveReadiness(from descriptor: Int32, process: SupervisorFoundationProcessBox, expectedDigest: String) throws -> String {
        let flags = fcntl(descriptor, F_GETFL)
        guard flags >= 0, fcntl(descriptor, F_SETFL, flags | O_NONBLOCK) == 0 else { throw ClientSupervisorError.processFailed }
        let deadline = DispatchTime.now().uptimeNanoseconds + UInt64(readinessTimeoutMilliseconds) * 1_000_000
        var bytes = Data()
        while bytes.count <= 512 {
            guard process.isRunning else { throw ClientSupervisorError.processFailed }
            var byte: UInt8 = 0
            let count = Darwin.read(descriptor, &byte, 1)
            if count == 1 {
                if byte == 0x0a { break }
                bytes.append(byte)
                continue
            }
            if count < 0 && errno == EINTR { continue }
            guard count < 0 && (errno == EAGAIN || errno == EWOULDBLOCK), DispatchTime.now().uptimeNanoseconds < deadline else {
                throw ClientSupervisorError.processFailed
            }
            let remaining = deadline - DispatchTime.now().uptimeNanoseconds
            var item = pollfd(fd: descriptor, events: Int16(POLLIN), revents: 0)
            let result = Darwin.poll(&item, 1, Int32(max(1, min(UInt64(Int32.max), (remaining + 999_999) / 1_000_000))))
            if result < 0 && errno == EINTR { continue }
            guard result > 0, item.revents & Int16(POLLERR | POLLNVAL) == 0 else { throw ClientSupervisorError.processFailed }
        }
        guard !bytes.isEmpty, bytes.count <= 512,
              let object = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any],
              Set(object.keys) == ["type", "generation", "parentPid", "configDigest"],
              object["type"] as? String == "triangle-client-supervisor-ready",
              let generation = object["generation"] as? String, UUID(uuidString: generation) != nil,
              object["parentPid"] as? Int == Int(parentPID),
              object["configDigest"] as? String == expectedDigest
        else { throw ClientSupervisorError.processFailed }
        return generation.lowercased()
    }

    private func writeReadinessMarker(generation: String, configDigest: String) throws {
        let parent = readinessMarkerURL.deletingLastPathComponent()
        var metadata = stat()
        guard lstat(parent.path, &metadata) == 0,
              (metadata.st_mode & S_IFMT) == S_IFDIR,
              metadata.st_uid == getuid(), metadata.st_mode & 0o777 == 0o700,
              parent.standardizedFileURL.resolvingSymlinksInPath().path == parent.standardizedFileURL.path
        else { throw ClientSupervisorError.processFailed }
        let document: [String: Any] = [
            "version": 1,
            "generation": generation,
            "parentPid": Int(parentPID),
            "configDigest": configDigest,
            "readyAtMilliseconds": Int64(Date().timeIntervalSince1970 * 1000),
        ]
        let data = try JSONSerialization.data(withJSONObject: document, options: [.sortedKeys])
        let temporary = parent.appendingPathComponent(".ready-\(UUID().uuidString).tmp")
        let descriptor = open(temporary.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard descriptor >= 0 else { throw ClientSupervisorError.processFailed }
        do {
            guard fchmod(descriptor, 0o600) == 0 else { throw ClientSupervisorError.processFailed }
            try data.withUnsafeBytes { raw in
                var offset = 0
                while offset < data.count {
                    let count = Darwin.write(descriptor, raw.baseAddress!.advanced(by: offset), data.count - offset)
                    if count < 0 && errno == EINTR { continue }
                    guard count > 0 else { throw ClientSupervisorError.processFailed }
                    offset += count
                }
            }
            guard fsync(descriptor) == 0 else { throw ClientSupervisorError.processFailed }
        } catch {
            close(descriptor); unlink(temporary.path); throw error
        }
        close(descriptor)
        guard rename(temporary.path, readinessMarkerURL.path) == 0 else { unlink(temporary.path); throw ClientSupervisorError.processFailed }
        let directory = open(parent.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard directory >= 0, fsync(directory) == 0 else { if directory >= 0 { close(directory) }; throw ClientSupervisorError.processFailed }
        close(directory)
    }

    private func writeActivationMarker(generation: String, configDigest: String) throws {
        let parent = activationMarkerURL.deletingLastPathComponent()
        var metadata = stat()
        guard lstat(parent.path, &metadata) == 0,
              (metadata.st_mode & S_IFMT) == S_IFDIR,
              metadata.st_uid == getuid(), metadata.st_mode & 0o777 == 0o700,
              parent.standardizedFileURL.resolvingSymlinksInPath().path == parent.standardizedFileURL.path
        else { throw ClientSupervisorError.processFailed }
        let document: [String: Any] = [
            "version": 1,
            "generation": generation,
            "parentPid": Int(parentPID),
            "configDigest": configDigest,
            "activatedAtMilliseconds": Int64(Date().timeIntervalSince1970 * 1000),
        ]
        let data = try JSONSerialization.data(withJSONObject: document, options: [.sortedKeys])
        let temporary = parent.appendingPathComponent(".activate-\(UUID().uuidString).tmp")
        let descriptor = open(temporary.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard descriptor >= 0 else { throw ClientSupervisorError.processFailed }
        do {
            guard fchmod(descriptor, 0o600) == 0 else { throw ClientSupervisorError.processFailed }
            try data.withUnsafeBytes { raw in
                var offset = 0
                while offset < data.count {
                    let count = Darwin.write(descriptor, raw.baseAddress!.advanced(by: offset), data.count - offset)
                    if count < 0 && errno == EINTR { continue }
                    guard count > 0 else { throw ClientSupervisorError.processFailed }
                    offset += count
                }
            }
            guard fsync(descriptor) == 0 else { throw ClientSupervisorError.processFailed }
        } catch {
            close(descriptor); unlink(temporary.path); throw error
        }
        close(descriptor)
        guard rename(temporary.path, activationMarkerURL.path) == 0 else { unlink(temporary.path); throw ClientSupervisorError.processFailed }
        let directory = open(parent.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard directory >= 0, fsync(directory) == 0 else { if directory >= 0 { close(directory) }; throw ClientSupervisorError.processFailed }
        close(directory)
    }

    private func writeBounded(_ data: Data, to descriptor: Int32, process: SupervisorFoundationProcessBox) throws {
        guard fcntl(descriptor, F_SETNOSIGPIPE, 1) == 0 else { throw ClientSupervisorError.processFailed }
        let flags = fcntl(descriptor, F_GETFL)
        guard flags >= 0, fcntl(descriptor, F_SETFL, flags | O_NONBLOCK) == 0 else {
            throw ClientSupervisorError.processFailed
        }
        let deadline = DispatchTime.now().uptimeNanoseconds + UInt64(inputHandoffTimeoutMilliseconds) * 1_000_000
        var offset = 0
        try data.withUnsafeBytes { bytes in
            guard let base = bytes.baseAddress else { return }
            while offset < data.count {
                guard process.isRunning else { throw ClientSupervisorError.processFailed }
                let count = Darwin.write(descriptor, base.advanced(by: offset), data.count - offset)
                if count > 0 {
                    offset += count
                    continue
                }
                if count < 0 && errno == EINTR { continue }
                guard count < 0 && (errno == EAGAIN || errno == EWOULDBLOCK) else {
                    throw ClientSupervisorError.processFailed
                }
                let now = DispatchTime.now().uptimeNanoseconds
                guard now < deadline else { throw ClientSupervisorError.processFailed }
                let remainingNanoseconds = deadline - now
                let remainingMilliseconds = max(1, min(Int(Int32.max), Int((remainingNanoseconds + 999_999) / 1_000_000)))
                var pollDescriptor = pollfd(fd: descriptor, events: Int16(POLLOUT), revents: 0)
                let pollResult = Darwin.poll(&pollDescriptor, 1, Int32(remainingMilliseconds))
                if pollResult < 0 && errno == EINTR { continue }
                guard pollResult > 0,
                      pollDescriptor.revents & Int16(POLLERR | POLLHUP | POLLNVAL) == 0
                else { throw ClientSupervisorError.processFailed }
            }
        }
    }

    private func terminateAndReap(_ process: SupervisorFoundationProcessBox) {
        if process.isRunning { process.forward(SIGTERM) }
        let deadline = DispatchTime.now().uptimeNanoseconds + UInt64(terminationGraceMilliseconds) * 1_000_000
        while process.isRunning && DispatchTime.now().uptimeNanoseconds < deadline {
            usleep(5_000)
        }
        if process.isRunning { process.forward(SIGKILL) }
        process.waitUntilExit()
    }
}

private final class SupervisorFoundationProcessBox: @unchecked Sendable {
    let process: Process
    init(_ process: Process) { self.process = process }
    var isRunning: Bool { process.isRunning }
    func forward(_ signal: Int32) {
        guard process.isRunning else { return }
        _ = Darwin.kill(process.processIdentifier, signal)
    }
    func waitUntilExit() { process.waitUntilExit() }
}

private typealias SupervisorSigactionFunction = @convention(c) (
    Int32,
    UnsafePointer<sigaction>?,
    UnsafeMutablePointer<sigaction>?
) -> Int32

private struct SupervisorSavedSignalActions {
    let interrupt: sigaction
    let terminate: sigaction
    let function: SupervisorSigactionFunction

    static func installIgnoring() throws -> Self {
        guard let symbol = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "sigaction") else {
            throw ClientSupervisorError.processFailed
        }
        let function = unsafeBitCast(symbol, to: SupervisorSigactionFunction.self)
        var interrupt = sigaction()
        var terminate = sigaction()
        guard function(SIGINT, nil, &interrupt) == 0,
              function(SIGTERM, nil, &terminate) == 0
        else { throw ClientSupervisorError.processFailed }
        var ignored = sigaction()
        ignored.__sigaction_u.__sa_handler = SIG_IGN
        sigemptyset(&ignored.sa_mask)
        ignored.sa_flags = 0
        guard function(SIGINT, &ignored, nil) == 0 else { throw ClientSupervisorError.processFailed }
        guard function(SIGTERM, &ignored, nil) == 0 else {
            var restore = interrupt
            _ = function(SIGINT, &restore, nil)
            throw ClientSupervisorError.processFailed
        }
        return Self(interrupt: interrupt, terminate: terminate, function: function)
    }

    func restore() {
        var interrupt = interrupt
        var terminate = terminate
        _ = function(SIGINT, &interrupt, nil)
        _ = function(SIGTERM, &terminate, nil)
    }
}
