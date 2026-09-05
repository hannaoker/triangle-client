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
    private static let coordinatorEnvironmentKeys: Set<String> = ["PATH", "LANG", "LC_ALL", "NO_COLOR"]

    private let instanceStore: any ClientInstanceStore
    private let gate: VerifiedCredentialGate
    private let workloadKeyStore: any WorkloadKeyStore
    private let resolver: any ClientSupervisorCommandResolving
    private let processRunner: any ClientSupervisorProcessRunning
    private let installationIdentity: any ClientInstallationIdentityStore
    private let helperExecutableURL: URL
    private let wakeCursorURL: URL

    public init(
        instanceStore: any ClientInstanceStore,
        gate: VerifiedCredentialGate,
        workloadKeyStore: (any WorkloadKeyStore)? = nil,
        resolver: any ClientSupervisorCommandResolving,
        processRunner: any ClientSupervisorProcessRunning,
        installationIdentity: (any ClientInstallationIdentityStore)? = nil,
        helperExecutableURL: URL? = nil,
        wakeCursorURL: URL? = nil
    ) {
        self.instanceStore = instanceStore
        self.gate = gate
        #if canImport(Security)
        self.workloadKeyStore = workloadKeyStore ?? KeychainWorkloadKeyStore()
        #else
        self.workloadKeyStore = workloadKeyStore ?? InMemoryWorkloadKeyStore()
        #endif
        self.resolver = resolver
        self.processRunner = processRunner
        self.installationIdentity = installationIdentity ?? FileClientInstallationIdentityStore()
        let home = FileManager.default.homeDirectoryForCurrentUser
        self.helperExecutableURL = helperExecutableURL
            ?? home.appendingPathComponent("Library/Application Support/The Triangle/bin/triangle-mailbox")
        self.wakeCursorURL = wakeCursorURL
            ?? home.appendingPathComponent("Library/Application Support/The Triangle/client/wake-cursor.json")
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
                return .init(instanceID: instance.instanceID.value, reasonCode: "delivery_mode_mcp_interactive")
            case .eventDriven, .worker:
                return nil
            }
        }
        let workers = allInstances.filter(\.participatesInWorkerPolling)
        let wakeMembers = allInstances.filter(\.participatesInEventDrivenWake)
        guard (!workers.isEmpty || !wakeMembers.isEmpty),
              Set(workers.map(\.profile)).count == workers.count,
              Set(wakeMembers.map(\.profile)).count == wakeMembers.count,
              workers.allSatisfy({ $0.instanceID == .derive(profile: $0.profile) }),
              wakeMembers.allSatisfy({ $0.instanceID == .derive(profile: $0.profile) })
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

        let coordinatorSources = !resolved.isEmpty ? resolved.map(\.instance) : wakeMembers
        guard !coordinatorSources.isEmpty else { throw ClientSupervisorError.noEligibleInstances }
        let coordinator: WorkerCommand
        do {
            coordinator = try resolver.resolveCoordinator(for: coordinatorSources)
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
        guard !prepared.isEmpty || eventWake != nil else {
            throw ClientSupervisorError.noEligibleInstances
        }

        let document = PreparedBootstrap(
            version: 1,
            maxConcurrentReasoners: 2,
            instances: prepared,
            eventWake: eventWake
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
        for instance in wakeMembers.sorted(by: { $0.profile.value < $1.profile.value }) {
            let credential: VerifiedCredential
            do {
                credential = try await gate.credential(for: instance.profile)
            } catch {
                omitted.append(.init(instanceID: instance.instanceID.value, reasonCode: "credential_ineligible"))
                continue
            }
            profiles.append(PreparedEventWakeProfile(
                instanceId: instance.instanceID.value,
                agentId: credential.agentID.value
            ))
        }
        guard !profiles.isEmpty else { throw ClientSupervisorError.noEligibleInstances }
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
            profiles: profiles
        )
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
        _ = try await prepareEnabledInstances()
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

    private enum CodingKeys: String, CodingKey {
        case version, maxConcurrentReasoners, instances, eventWake
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(version, forKey: .version)
        try container.encode(maxConcurrentReasoners, forKey: .maxConcurrentReasoners)
        try container.encode(instances, forKey: .instances)
        try container.encodeIfPresent(eventWake, forKey: .eventWake)
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
}
private struct PreparedEventWakeProfile: Encodable {
    let instanceId: String
    let agentId: String
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
