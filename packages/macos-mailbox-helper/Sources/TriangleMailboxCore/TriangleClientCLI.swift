import Darwin
import CryptoKit
import Foundation

public enum TriangleClientCommandParseError: Error, Equatable, Sendable { case invalidArguments }
public enum TriangleClientOperationError: Error, Equatable, Sendable { case runtimeUnavailable }
public enum TriangleClientLifecycleError: Error, Equatable, Sendable { case reloadFailed, rollbackFailed, cleanupFailed }

public protocol TriangleClientServiceControlling: Sendable { func applyAndVerify(shouldRun: Bool) throws }
public protocol TriangleClientMutableStateCleaning: Sendable { func removeMutableState(for instanceID: ClientInstanceID) throws }
public protocol TriangleClientLifecycleLease: Sendable { func release() }
public protocol TriangleClientLifecycleLocking: Sendable { func acquire() throws -> any TriangleClientLifecycleLease }

public enum TriangleClientAgentCommand: Equatable, Sendable {
    case add(profile: ProfileName, adapter: RuntimeAdapter)
    case list
    case status(profile: ProfileName)
    case enable(profile: ProfileName)
    case disable(profile: ProfileName)
    case remove(profile: ProfileName)
    case setDeliveryMode(profile: ProfileName, mode: DeliveryMode)
}

public enum TriangleClientCommandParser {
    public static func parse(_ arguments: [String]) throws -> TriangleClientAgentCommand {
        guard arguments.count >= 2, arguments[0] == "agent" else { throw TriangleClientCommandParseError.invalidArguments }
        let action = arguments[1], flags = Array(arguments.dropFirst(2))
        switch action {
        case "list":
            guard flags.isEmpty else { throw TriangleClientCommandParseError.invalidArguments }; return .list
        case "add":
            let values = try exactFlags(flags, allowed: ["--profile", "--runtime"])
            guard let rawProfile = values["--profile"], let rawRuntime = values["--runtime"], let adapter = RuntimeAdapter(rawValue: rawRuntime) else { throw TriangleClientCommandParseError.invalidArguments }
            do { return .add(profile: try ProfileName(rawProfile), adapter: adapter) }
            catch { throw TriangleClientCommandParseError.invalidArguments }
        case "status", "enable", "disable", "remove":
            let values = try exactFlags(flags, allowed: ["--profile"])
            guard let rawProfile = values["--profile"] else { throw TriangleClientCommandParseError.invalidArguments }
            let profile: ProfileName
            do { profile = try ProfileName(rawProfile) } catch { throw TriangleClientCommandParseError.invalidArguments }
            switch action { case "status": return .status(profile: profile); case "enable": return .enable(profile: profile); case "disable": return .disable(profile: profile); default: return .remove(profile: profile) }
        case "set-delivery-mode":
            let values = try exactFlags(flags, allowed: ["--profile", "--mode"])
            guard let rawProfile = values["--profile"], let rawMode = values["--mode"], let mode = DeliveryMode(rawValue: rawMode) else {
                throw TriangleClientCommandParseError.invalidArguments
            }
            do { return .setDeliveryMode(profile: try ProfileName(rawProfile), mode: mode) }
            catch { throw TriangleClientCommandParseError.invalidArguments }
        default: throw TriangleClientCommandParseError.invalidArguments
        }
    }

    private static func exactFlags(_ arguments: [String], allowed: Set<String>) throws -> [String: String] {
        guard arguments.count == allowed.count * 2 else { throw TriangleClientCommandParseError.invalidArguments }
        var values: [String: String] = [:], index = 0
        while index < arguments.count {
            let flag = arguments[index]
            guard allowed.contains(flag), values[flag] == nil, index + 1 < arguments.count else { throw TriangleClientCommandParseError.invalidArguments }
            let value = arguments[index + 1]
            guard !value.hasPrefix("--") else { throw TriangleClientCommandParseError.invalidArguments }
            values[flag] = value; index += 2
        }
        guard Set(values.keys) == allowed else { throw TriangleClientCommandParseError.invalidArguments }; return values
    }
}

public struct TriangleClientAgentService: Sendable {
    private let instanceStore: any ClientInstanceStore
    private let credentialGate: VerifiedCredentialGate
    private let runtimeReadiness: @Sendable (ClientInstance) throws -> Void
    private let serviceControl: any TriangleClientServiceControlling
    private let stateCleaner: any TriangleClientMutableStateCleaning
    private let lifecycleLock: any TriangleClientLifecycleLocking

    public init(instanceStore: any ClientInstanceStore, credentialGate: VerifiedCredentialGate, runtimeReadiness: @escaping @Sendable (ClientInstance) throws -> Void, serviceControl: any TriangleClientServiceControlling, stateCleaner: any TriangleClientMutableStateCleaning, lifecycleLock: any TriangleClientLifecycleLocking) {
        self.instanceStore = instanceStore; self.credentialGate = credentialGate; self.runtimeReadiness = runtimeReadiness; self.serviceControl = serviceControl; self.stateCleaner = stateCleaner; self.lifecycleLock = lifecycleLock
    }

    public func execute(_ command: TriangleClientAgentCommand) async throws -> Data {
        switch command {
        case let .add(profile, adapter):
            let lease = try lifecycleLock.acquire(); defer { lease.release() }
            do { _ = try instanceStore.read(profile: profile); throw ClientInstanceStoreError.duplicateProfile }
            catch ClientInstanceStoreError.notFound {}
            let instance = try ClientInstance(profile: profile, runtimeAdapter: adapter)
            _ = try await credentialGate.credential(for: profile); try runtimeReadiness(instance)
            try instanceStore.create(instance)
            try reloadOrRollback { try instanceStore.remove(profile: profile); try stateCleaner.removeMutableState(for: instance.instanceID) }
            return try render(operation: "added", agents: [instance])
        case .list: return try render(operation: "listed", agents: instanceStore.list())
        case let .status(profile): return try render(operation: "status", agents: [instanceStore.read(profile: profile)])
        case let .enable(profile):
            let lease = try lifecycleLock.acquire(); defer { lease.release() }
            let previous = try instanceStore.read(profile: profile)
            _ = try await credentialGate.credential(for: profile)
            try runtimeReadiness(previous)
            try instanceStore.setEnabled(true, profile: profile)
            try reloadOrRollback { try instanceStore.setEnabled(previous.enabled, profile: profile) }
            return try render(operation: "enabled", agents: [instanceStore.read(profile: profile)])
        case let .disable(profile):
            let lease = try lifecycleLock.acquire(); defer { lease.release() }
            let previous = try instanceStore.read(profile: profile)
            try instanceStore.setEnabled(false, profile: profile)
            try reloadOrRollback { try instanceStore.setEnabled(previous.enabled, profile: profile) }
            return try render(operation: "disabled", agents: [instanceStore.read(profile: profile)])
        case let .remove(profile):
            let lease = try lifecycleLock.acquire(); defer { lease.release() }
            let removed = try instanceStore.read(profile: profile)
            try instanceStore.remove(profile: profile)
            try reloadOrRollback { try instanceStore.create(removed) }
            do { try stateCleaner.removeMutableState(for: removed.instanceID) }
            catch { throw TriangleClientLifecycleError.cleanupFailed }
            return try render(operation: "removed", agents: [removed])
        case let .setDeliveryMode(profile, mode):
            let lease = try lifecycleLock.acquire(); defer { lease.release() }
            let previous = try instanceStore.read(profile: profile)
            try instanceStore.setDeliveryMode(mode, profile: profile)
            try reloadOrRollback { try instanceStore.setDeliveryMode(previous.deliveryMode, profile: profile) }
            return try render(operation: "delivery_mode_set", agents: [instanceStore.read(profile: profile)])
        }
    }

    private func reloadOrRollback(_ rollback: () throws -> Void) throws {
        do {
            try serviceControl.applyAndVerify(
                shouldRun: try instanceStore.list().contains(where: { $0.participatesInWorkerPolling })
            )
        }
        catch {
            do { try rollback(); try serviceControl.applyAndVerify(shouldRun: try instanceStore.list().contains(where: { $0.participatesInWorkerPolling })) }
            catch { throw TriangleClientLifecycleError.rollbackFailed }
            throw TriangleClientLifecycleError.reloadFailed
        }
    }

    private func render(operation: String, agents: [ClientInstance]) throws -> Data {
        let document = AgentDocument(version: 1, operation: operation, agents: agents.map {
            AgentSummary(
                profile: $0.profile.value,
                instanceID: $0.instanceID.value,
                runtimeAdapter: $0.runtimeAdapter.rawValue,
                enabled: $0.enabled,
                deliveryMode: $0.deliveryMode.rawValue
            )
        })
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        var output = try encoder.encode(document); output.append(0x0a); return output
    }
}

private struct AgentDocument: Codable, Sendable { let version: Int; let operation: String; let agents: [AgentSummary] }
private struct AgentSummary: Codable, Sendable {
    let profile: String; let instanceID: String; let runtimeAdapter: String; let enabled: Bool; let deliveryMode: String
    private enum CodingKeys: String, CodingKey { case profile, instanceID = "instanceId", runtimeAdapter, enabled, deliveryMode }
}

public struct LaunchdTriangleClientServiceControl: TriangleClientServiceControlling {
    private static let executable = URL(fileURLWithPath: "/bin/launchctl")
    private static let label = "dev.thetriangle.client"
    private let executableURL: URL
    private let homeURL: URL
    private let readinessTimeoutMilliseconds: Int
    private let stabilityMilliseconds: Int
    public init() {
        executableURL = Self.executable
        homeURL = FileManager.default.homeDirectoryForCurrentUser
        readinessTimeoutMilliseconds = 10_000
        stabilityMilliseconds = 500
    }
    @_spi(TriangleClientTesting)
    public init(executableURL: URL, home: URL, readinessTimeoutMilliseconds: Int, stabilityMilliseconds: Int) {
        self.executableURL = executableURL
        self.homeURL = home
        self.readinessTimeoutMilliseconds = readinessTimeoutMilliseconds
        self.stabilityMilliseconds = stabilityMilliseconds
    }

    public func applyAndVerify(shouldRun: Bool) throws {
        let target = "gui/\(getuid())/\(Self.label)"
        try validateInstallation()
        let loaded = (try? run(["print", target], capture: true)) != nil
        if shouldRun {
            let legacy = try captureLoadedLegacy()
            do {
                try clearReadinessMarker()
                let started = Date()
                if !loaded {
                    let domain = "gui/\(getuid())"
                    let plist = home.appendingPathComponent("Library/LaunchAgents/\(Self.label).plist").path
                    try run(["bootstrap", domain, plist], capture: false)
                } else {
                    try run(["kickstart", "-k", target], capture: false)
                }
                let readiness = try waitForReadiness(target: target, notBefore: started)
                try retireLegacy(legacy)
                try writeActivationMarker(readiness)
            } catch {
                do {
                    try run(["bootout", target], capture: false)
                    guard (try? run(["print", target], capture: true)) == nil else { throw TriangleClientLifecycleError.rollbackFailed }
                    try clearReadinessMarker()
                    try restoreLegacy(legacy)
                }
                catch { throw TriangleClientLifecycleError.rollbackFailed }
                throw TriangleClientLifecycleError.reloadFailed
            }
        } else {
            if loaded { try run(["bootout", target], capture: false) }
            guard (try? run(["print", target], capture: true)) == nil else { throw TriangleClientLifecycleError.reloadFailed }
            try clearReadinessMarker()
        }
    }

    private var home: URL { homeURL }
    private var readinessMarker: URL { home.appendingPathComponent("Library/Application Support/The Triangle/client/ready.json") }
    private var activationMarker: URL { home.appendingPathComponent("Library/Application Support/The Triangle/client/activate.json") }
    private var launchAgents: URL { home.appendingPathComponent("Library/LaunchAgents", isDirectory: true) }
    private var legacyLabels: [String] { ["dev.thetriangle.codex.worker", "dev.thetriangle.hermes.worker"] }

    private func captureLoadedLegacy() throws -> [String] {
        var loaded: [String] = []
        for label in legacyLabels {
            let target = "gui/\(getuid())/\(label)"
            guard (try? run(["print", target], capture: true)) != nil else { continue }
            let plist = launchAgents.appendingPathComponent("\(label).plist")
            try validateFile(plist, mode: 0o600)
            let object = try PropertyListSerialization.propertyList(from: Data(contentsOf: plist), format: nil) as? [String: Any]
            guard object?["Label"] as? String == label else { throw TriangleClientLifecycleError.reloadFailed }
            loaded.append(label)
        }
        return loaded
    }

    private func retireLegacy(_ labels: [String]) throws {
        for label in labels {
            let target = "gui/\(getuid())/\(label)"
            try run(["bootout", target], capture: false)
            guard (try? run(["print", target], capture: true)) == nil else { throw TriangleClientLifecycleError.reloadFailed }
        }
    }

    private func restoreLegacy(_ labels: [String]) throws {
        for label in labels {
            let target = "gui/\(getuid())/\(label)"
            if (try? run(["print", target], capture: true)) == nil {
                try run(["bootstrap", "gui/\(getuid())", launchAgents.appendingPathComponent("\(label).plist").path], capture: false)
            }
            guard (try? run(["print", target], capture: true)) != nil else { throw TriangleClientLifecycleError.rollbackFailed }
        }
    }

    private func clearReadinessMarker() throws {
        for marker in [readinessMarker, activationMarker] {
            guard FileManager.default.fileExists(atPath: marker.path) else { continue }
            try validateFile(marker, mode: 0o600)
            do { try FileManager.default.removeItem(at: marker) }
            catch { throw TriangleClientLifecycleError.reloadFailed }
        }
    }

    private struct Readiness: Sendable { let generation: String; let configDigest: String; let parentPID: Int }

    private func waitForReadiness(target: String, notBefore: Date) throws -> Readiness {
        guard (20...60_000).contains(readinessTimeoutMilliseconds), (20...5_000).contains(stabilityMilliseconds) else { throw TriangleClientLifecycleError.reloadFailed }
        let deadline = Date().addingTimeInterval(TimeInterval(readinessTimeoutMilliseconds) / 1000)
        repeat {
            if let output = try? run(["print", target], capture: true),
               output.split(separator: "\n").contains(where: { $0.trimmingCharacters(in: .whitespaces) == "state = running" }),
               let pid = launchPID(output),
               let readiness = readinessMarkerValue(parentPID: pid, notBefore: notBefore, now: Date()) {
                let stableUntil = Date().addingTimeInterval(TimeInterval(stabilityMilliseconds) / 1000)
                repeat {
                    guard let stableOutput = try? run(["print", target], capture: true),
                          stableOutput.split(separator: "\n").contains(where: { $0.trimmingCharacters(in: .whitespaces) == "state = running" }),
                          launchPID(stableOutput) == pid,
                          readinessMarkerValue(parentPID: pid, notBefore: notBefore, now: Date()) != nil
                    else { throw TriangleClientLifecycleError.reloadFailed }
                    if Date() >= stableUntil { return readiness }
                    usleep(20_000)
                } while true
            }
            usleep(20_000)
        } while Date() < deadline
        throw TriangleClientLifecycleError.reloadFailed
    }

    private func launchPID(_ output: String) -> Int? {
        for line in output.split(separator: "\n") {
            let value = line.trimmingCharacters(in: .whitespaces)
            guard value.hasPrefix("pid = ") else { continue }
            let raw = value.dropFirst("pid = ".count)
            if let pid = Int(raw), pid > 0 { return pid }
        }
        return nil
    }

    private func readinessMarkerValue(parentPID: Int, notBefore: Date, now: Date) -> Readiness? {
        do {
            try validateFile(readinessMarker, mode: 0o600)
            var metadata = stat(); guard lstat(readinessMarker.path, &metadata) == 0, metadata.st_nlink == 1, metadata.st_size <= 1024 else { return nil }
            let value = try JSONSerialization.jsonObject(with: Data(contentsOf: readinessMarker)) as? [String: Any]
            let keys: Set<String> = ["version", "generation", "parentPid", "configDigest", "readyAtMilliseconds"]
            guard let value, Set(value.keys) == keys,
                  value["version"] as? Int == 1,
                  value["parentPid"] as? Int == parentPID,
                  let generation = value["generation"] as? String, UUID(uuidString: generation) != nil,
                  let digest = value["configDigest"] as? String, digest.wholeMatch(of: /^[0-9a-f]{64}$/) != nil,
                  let milliseconds = value["readyAtMilliseconds"] as? Int64
            else { return nil }
            let ready = Date(timeIntervalSince1970: TimeInterval(milliseconds) / 1000)
            guard ready >= notBefore && ready <= now.addingTimeInterval(2) else { return nil }
            return Readiness(generation: generation.lowercased(), configDigest: digest, parentPID: parentPID)
        } catch { return nil }
    }

    private func writeActivationMarker(_ readiness: Readiness) throws {
        let parent = activationMarker.deletingLastPathComponent()
        let document: [String: Any] = [
            "version": 1,
            "generation": readiness.generation,
            "parentPid": readiness.parentPID,
            "configDigest": readiness.configDigest,
            "activatedAtMilliseconds": Int64(Date().timeIntervalSince1970 * 1000),
        ]
        let data = try JSONSerialization.data(withJSONObject: document, options: [.sortedKeys])
        let temporary = parent.appendingPathComponent(".activate-\(UUID().uuidString).tmp")
        let descriptor = open(temporary.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard descriptor >= 0 else { throw TriangleClientLifecycleError.reloadFailed }
        do {
            guard fchmod(descriptor, 0o600) == 0 else { throw TriangleClientLifecycleError.reloadFailed }
            try data.withUnsafeBytes { raw in
                var offset = 0
                while offset < data.count {
                    let count = Darwin.write(descriptor, raw.baseAddress!.advanced(by: offset), data.count - offset)
                    if count < 0 && errno == EINTR { continue }
                    guard count > 0 else { throw TriangleClientLifecycleError.reloadFailed }
                    offset += count
                }
            }
            guard fsync(descriptor) == 0 else { throw TriangleClientLifecycleError.reloadFailed }
        } catch { close(descriptor); unlink(temporary.path); throw error }
        close(descriptor)
        guard rename(temporary.path, activationMarker.path) == 0 else { unlink(temporary.path); throw TriangleClientLifecycleError.reloadFailed }
        let directory = open(parent.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard directory >= 0, fsync(directory) == 0 else { if directory >= 0 { close(directory) }; throw TriangleClientLifecycleError.reloadFailed }
        close(directory)
    }

    private func validateInstallation() throws {
        let application = home.appendingPathComponent("Library/Application Support/The Triangle", isDirectory: true)
        let helper = application.appendingPathComponent("bin/triangle-mailbox")
        let hash = application.appendingPathComponent("install-manifest/triangle-mailbox.sha256")
        let plist = home.appendingPathComponent("Library/LaunchAgents/\(Self.label).plist")
        try validateFile(helper, mode: 0o700); try validateFile(hash, mode: 0o600); try validateFile(plist, mode: 0o600)
        let expected = try String(contentsOf: hash, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
        let actual = SHA256.hash(data: try Data(contentsOf: helper)).map { String(format: "%02x", $0) }.joined()
        guard expected.wholeMatch(of: /^[a-f0-9]{64}$/) != nil, expected == actual else { throw TriangleClientLifecycleError.reloadFailed }
        let object = try PropertyListSerialization.propertyList(from: Data(contentsOf: plist), format: nil)
        let logs = home.appendingPathComponent("Library/Logs/the-triangle", isDirectory: true)
        let expectedKeys: Set<String> = ["Label", "ProgramArguments", "RunAtLoad", "KeepAlive", "ThrottleInterval", "StandardOutPath", "StandardErrorPath"]
        guard let values = object as? [String: Any], Set(values.keys) == expectedKeys, values["Label"] as? String == Self.label,
              values["ProgramArguments"] as? [String] == [helper.path, "run-supervisor"],
              values["RunAtLoad"] as? Bool == true, values["KeepAlive"] as? Bool == true,
              values["ThrottleInterval"] as? Int == 10,
              values["StandardOutPath"] as? String == logs.appendingPathComponent("client.log").path,
              values["StandardErrorPath"] as? String == logs.appendingPathComponent("client.error.log").path
        else { throw TriangleClientLifecycleError.reloadFailed }
    }

    private func validateFile(_ url: URL, mode: mode_t) throws {
        guard url.standardizedFileURL.resolvingSymlinksInPath().path == url.standardizedFileURL.path else { throw TriangleClientLifecycleError.reloadFailed }
        var metadata = stat()
        guard lstat(url.path, &metadata) == 0, (metadata.st_mode & S_IFMT) == S_IFREG, metadata.st_uid == getuid(), metadata.st_mode & 0o777 == mode else { throw TriangleClientLifecycleError.reloadFailed }
    }

    @discardableResult
    private func run(_ arguments: [String], capture: Bool) throws -> String {
        let process = Process(); process.executableURL = executableURL; process.arguments = arguments
        process.environment = ["HOME": home.path, "PATH": "/usr/bin:/bin", "LANG": "C", "LC_ALL": "C"]
        let pipe = Pipe()
        if capture { process.standardOutput = pipe } else { process.standardOutput = FileHandle.nullDevice }
        process.standardError = FileHandle.nullDevice
        do { try process.run() } catch { throw TriangleClientLifecycleError.reloadFailed }
        let data = capture ? pipe.fileHandleForReading.readDataToEndOfFile() : Data()
        process.waitUntilExit()
        guard process.terminationReason == .exit, process.terminationStatus == 0, data.count <= 64 * 1024 else { throw TriangleClientLifecycleError.reloadFailed }
        return String(decoding: data, as: UTF8.self)
    }
}

public struct FileTriangleClientMutableStateCleaner: TriangleClientMutableStateCleaning {
    private let home: URL
    private let traversalHook: (@Sendable (URL) throws -> Void)?
    private static let roots = [
        ["Library", "Application Support", "The Triangle", "model-state", "instances"],
        ["Library", "Caches", "The Triangle", "instances"],
    ]
    public init(home: URL = FileManager.default.homeDirectoryForCurrentUser) {
        self.home = home.standardizedFileURL
        traversalHook = nil
    }
    @_spi(TriangleClientTesting)
    public init(home: URL, traversalHook: @escaping @Sendable (URL) throws -> Void) {
        self.home = home.standardizedFileURL
        self.traversalHook = traversalHook
    }

    public func removeMutableState(for instanceID: ClientInstanceID) throws {
        for components in Self.roots {
            try withRoot(components) { root in
                try quarantineAndRemove(instanceID: instanceID, root: root)
            }
        }
    }

    private func withRoot(_ components: [String], body: (Int32) throws -> Void) throws {
        guard home.resolvingSymlinksInPath().path == home.path else { throw TriangleClientLifecycleError.cleanupFailed }
        let homeDescriptor = open(home.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard homeDescriptor >= 0 else { throw TriangleClientLifecycleError.cleanupFailed }
        var descriptors = [homeDescriptor]
        defer { for descriptor in descriptors.reversed() { close(descriptor) } }
        try validateDirectoryDescriptor(homeDescriptor, exactPrivateMode: false)
        var current = homeDescriptor
        var rootURL = home
        var managed = false
        for component in components {
            guard !component.isEmpty, component != ".", component != "..", !component.contains("/") else { throw TriangleClientLifecycleError.cleanupFailed }
            let next = openat(current, component, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
            if next < 0 {
                if errno == ENOENT { return }
                throw TriangleClientLifecycleError.cleanupFailed
            }
            descriptors.append(next)
            if component == "The Triangle" { managed = true }
            try validateDirectoryDescriptor(next, exactPrivateMode: managed)
            current = next
            rootURL.appendPathComponent(component, isDirectory: true)
        }
        try traversalHook?(rootURL)
        try body(current)
    }

    private func validateDirectoryDescriptor(_ descriptor: Int32, exactPrivateMode: Bool) throws {
        var metadata = stat()
        guard fstat(descriptor, &metadata) == 0, (metadata.st_mode & S_IFMT) == S_IFDIR, metadata.st_uid == getuid() else { throw TriangleClientLifecycleError.cleanupFailed }
        let mode = metadata.st_mode & 0o777
        guard exactPrivateMode ? mode == 0o700 : mode & 0o022 == 0 else { throw TriangleClientLifecycleError.cleanupFailed }
    }

    private func quarantineAndRemove(instanceID: ClientInstanceID, root: Int32) throws {
        let name = instanceID.value
        var metadata = stat()
        if fstatat(root, name, &metadata, AT_SYMLINK_NOFOLLOW) != 0 {
            if errno == ENOENT { return }
            throw TriangleClientLifecycleError.cleanupFailed
        }
        guard (metadata.st_mode & S_IFMT) == S_IFDIR, metadata.st_uid == getuid(), metadata.st_mode & 0o777 == 0o700 else { throw TriangleClientLifecycleError.cleanupFailed }
        let quarantined = ".deleting-\(name)-\(UUID().uuidString.lowercased())"
        guard renameatx_np(root, name, root, quarantined, UInt32(RENAME_EXCL)) == 0, fsync(root) == 0 else { throw TriangleClientLifecycleError.cleanupFailed }
        try removeDirectory(parent: root, name: quarantined)
        guard fsync(root) == 0 else { throw TriangleClientLifecycleError.cleanupFailed }
    }

    private func removeDirectory(parent: Int32, name: String) throws {
        let directory = openat(parent, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard directory >= 0 else { throw TriangleClientLifecycleError.cleanupFailed }
        defer { close(directory) }
        try validateDirectoryDescriptor(directory, exactPrivateMode: false)
        let duplicate = dup(directory)
        guard duplicate >= 0, let stream = fdopendir(duplicate) else {
            if duplicate >= 0 { close(duplicate) }
            throw TriangleClientLifecycleError.cleanupFailed
        }
        var names: [String] = []
        while let entry = readdir(stream) {
            let entryName = withUnsafePointer(to: &entry.pointee.d_name) {
                $0.withMemoryRebound(to: CChar.self, capacity: Int(MAXNAMLEN) + 1) { String(cString: $0) }
            }
            if entryName != "." && entryName != ".." { names.append(entryName) }
        }
        closedir(stream)
        for entryName in names {
            var metadata = stat()
            guard fstatat(directory, entryName, &metadata, AT_SYMLINK_NOFOLLOW) == 0, metadata.st_uid == getuid() else { throw TriangleClientLifecycleError.cleanupFailed }
            if (metadata.st_mode & S_IFMT) == S_IFDIR {
                try removeDirectory(parent: directory, name: entryName)
            } else {
                guard unlinkat(directory, entryName, 0) == 0 else { throw TriangleClientLifecycleError.cleanupFailed }
            }
        }
        guard fsync(directory) == 0, unlinkat(parent, name, AT_REMOVEDIR) == 0 else { throw TriangleClientLifecycleError.cleanupFailed }
    }
}

public struct FileTriangleClientLifecycleLock: TriangleClientLifecycleLocking {
    private let applicationRoot: URL
    public init(home: URL = FileManager.default.homeDirectoryForCurrentUser) {
        applicationRoot = home.appendingPathComponent("Library/Application Support/The Triangle", isDirectory: true)
    }
    public func acquire() throws -> any TriangleClientLifecycleLease {
        var metadata = stat()
        guard lstat(applicationRoot.path, &metadata) == 0, (metadata.st_mode & S_IFMT) == S_IFDIR, metadata.st_uid == getuid(), metadata.st_mode & 0o777 == 0o700 else { throw TriangleClientLifecycleError.rollbackFailed }
        let directory = open(applicationRoot.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard directory >= 0 else { throw TriangleClientLifecycleError.rollbackFailed }
        defer { close(directory) }
        let name = ".client-lifecycle.lock"
        let descriptor = openat(directory, name, O_CREAT | O_RDWR | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard descriptor >= 0 else { throw TriangleClientLifecycleError.rollbackFailed }
        guard fstat(descriptor, &metadata) == 0, (metadata.st_mode & S_IFMT) == S_IFREG, metadata.st_uid == getuid(), metadata.st_mode & 0o777 == 0o600, metadata.st_nlink == 1, flock(descriptor, LOCK_EX) == 0 else { close(descriptor); throw TriangleClientLifecycleError.rollbackFailed }
        return FileTriangleClientLifecycleLease(descriptor: descriptor)
    }
}

private final class FileTriangleClientLifecycleLease: TriangleClientLifecycleLease, @unchecked Sendable {
    private let lock = NSLock(); private var descriptor: Int32?
    init(descriptor: Int32) { self.descriptor = descriptor }
    func release() { lock.withLock { guard let descriptor else { return }; _ = flock(descriptor, LOCK_UN); close(descriptor); self.descriptor = nil } }
    deinit { release() }
}
