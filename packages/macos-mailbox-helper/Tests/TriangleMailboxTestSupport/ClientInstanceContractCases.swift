import Foundation
@_spi(ClientInstanceTesting) import TriangleMailboxCore

public enum ClientInstanceContractCases {
    public struct ContractCase: Sendable {
        public let name: String
        public let run: @Sendable () throws -> Void
    }

    public static let all: [ContractCase] = [
        .init(name: "Triangle Client instance identity derivation", run: identityDerivation),
        .init(name: "Triangle Client instance create, read, and ordering", run: createReadAndOrdering),
        .init(name: "Triangle Client duplicate and cross-runtime refusal", run: duplicateAndCrossRuntimeRefusal),
        .init(name: "Triangle Client strict record schema", run: strictSchemaAndIdentifierValidation),
        .init(name: "Triangle Client duplicate JSON member refusal", run: duplicateMemberRefusal),
        .init(name: "Triangle Client private atomic storage", run: safeAtomicStorage),
        .init(name: "Triangle Client atomic-create crash recovery", run: atomicCreateCrashRecovery),
        .init(name: "Triangle Client serialized transitions", run: serializedTransitions),
        .init(name: "Triangle Client unsafe metadata refusal", run: unsafeMetadataRefusal),
        .init(name: "Triangle Client exact lifecycle", run: exactLifecycleAndCredentialPreservation),
    ]

    public static func identityDerivation() throws {
        let research = try ProfileName("research")
        let unicode = try ProfileName("研究🤖")
        try expect(ClientInstanceID.derive(profile: research).value == "1d5ebff806cab118f9d67bff3d90c591ef05ba3495f43db418b78ac1507f6a42", "framed research digest changed")
        try expect(ClientInstanceID.derive(profile: unicode).value == "fda13a7a79c0e25741bb0e312e36c38bb4c0e7e3074b3c120e48fc962cd3dd4c", "Unicode profile was not hashed as UTF-8")
        for profile in [research, unicode] {
            let value = ClientInstanceID.derive(profile: profile).value
            try expect(value.wholeMatch(of: /^[a-f0-9]{64}$/) != nil, "instance identifier is not a full lowercase SHA-256 digest")
        }
    }

    public static func createReadAndOrdering() throws {
        try withStore { store, _ in
            let zeta = try ClientInstance(profile: ProfileName("zeta"), runtimeAdapter: .hermes)
            let alpha = try ClientInstance(profile: ProfileName("alpha"), runtimeAdapter: .codex)
            try store.create(zeta)
            try store.create(alpha)
            try expect(try store.read(profile: alpha.profile) == alpha, "created instance did not round trip")
            try expect(try store.list().map(\.profile.value) == ["alpha", "zeta"], "instances were not listed by profile")
        }
    }

    public static func duplicateAndCrossRuntimeRefusal() throws {
        try withStore { store, _ in
            let profile = try ProfileName("research")
            try store.create(ClientInstance(profile: profile, runtimeAdapter: .codex))
            try expectError(.duplicateProfile, "duplicate profile was accepted") {
                try store.create(ClientInstance(profile: profile, runtimeAdapter: .codex))
            }
            try expectError(.duplicateProfile, "profile was rebound across runtimes") {
                try store.create(ClientInstance(profile: profile, runtimeAdapter: .hermes))
            }
            try expect(try store.read(profile: profile).runtimeAdapter == .codex, "failed rebinding changed the record")
        }
    }

    public static func strictSchemaAndIdentifierValidation() throws {
        try withStore { store, root in
            let profile = try ProfileName("research")
            let instance = try ClientInstance(profile: profile, runtimeAdapter: .codex)
            try expect(try store.list().isEmpty, "fresh store was not empty")
            let record = root.appendingPathComponent(instance.instanceID.value + ".json")
            let invalid = """
            {"version":1,"instanceId":"\(instance.instanceID.value)","profile":"research","runtimeAdapter":"codex","enabled":true,"extra":false}
            """
            try Data(invalid.utf8).write(to: record)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: record.path)
            try expectError(.invalidRecord, "unknown JSON key was accepted") { _ = try store.read(profile: profile) }

            try FileManager.default.removeItem(at: record)
            let wrongID = String(repeating: "a", count: 64)
            let mismatched = """
            {"version":1,"instanceId":"\(wrongID)","profile":"research","runtimeAdapter":"codex","enabled":true}
            """
            try Data(mismatched.utf8).write(to: record)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: record.path)
            try expectError(.invalidRecord, "record identifier was not recomputed") { _ = try store.read(profile: profile) }
        }
    }

    public static func safeAtomicStorage() throws {
        try withStore { store, root in
            let instance = try ClientInstance(profile: ProfileName("research"), runtimeAdapter: .codex)
            try store.create(instance)
            let rootMode = try mode(root)
            let record = root.appendingPathComponent(instance.instanceID.value + ".json")
            try expect(rootMode == 0o700, "instance directory is not mode 0700")
            try expect(try mode(record) == 0o600, "instance record is not mode 0600")
            try expect(try FileManager.default.contentsOfDirectory(atPath: root.path).allSatisfy { !$0.hasPrefix(".tmp-") }, "atomic temporary file was left behind")

            try FileManager.default.removeItem(at: record)
            try FileManager.default.createSymbolicLink(atPath: record.path, withDestinationPath: "/dev/null")
            try expectError(.unsafeStorage, "symlink record was accepted") { _ = try store.read(profile: instance.profile) }
        }

        let parent = FileManager.default.temporaryDirectory.appendingPathComponent("triangle-client-symlink-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: parent, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        defer { try? FileManager.default.removeItem(at: parent) }
        let root = parent.appendingPathComponent("instances")
        try FileManager.default.createSymbolicLink(atPath: root.path, withDestinationPath: "/tmp")
        let store = FileClientInstanceStore(testRoot: root)
        try expectError(.unsafeStorage, "symlink instance directory was accepted") { _ = try store.list() }
    }

    public static func duplicateMemberRefusal() throws {
        for duplicate in [
            "\"runtimeAdapter\":\"codex\",\"runtimeAdapter\":\"hermes\"",
            "\"enabled\":true,\"enabled\":false",
            "\"runtime\\u0041dapter\":\"codex\",\"runtimeAdapter\":\"hermes\"",
        ] {
            try withStore { store, root in
                let profile = try ProfileName("research")
                let instanceID = ClientInstanceID.derive(profile: profile)
                try expect(try store.list().isEmpty, "fresh store was not empty")
                let record = root.appendingPathComponent(instanceID.value + ".json")
                let json = "{\"version\":1,\"instanceId\":\"\(instanceID.value)\",\"profile\":\"research\",\(duplicate)}"
                try Data(json.utf8).write(to: record)
                try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: record.path)
                try expectError(.invalidRecord, "duplicate JSON member was accepted") { _ = try store.read(profile: profile) }
            }
        }
    }

    public static func atomicCreateCrashRecovery() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("triangle-client-crash-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let instance = try ClientInstance(profile: ProfileName("research"), runtimeAdapter: .codex)

        let beforeCommit = FileClientInstanceStore(testRoot: root, simulatedCrashAt: .afterTemporaryFsync)
        try expectError(.unsafeStorage, "simulated pre-commit crash did not interrupt create") { try beforeCommit.create(instance) }
        try expect(FileManager.default.fileExists(atPath: root.path), "crash fixture did not create the instance directory")
        try expect(try FileManager.default.contentsOfDirectory(atPath: root.path).contains { $0.hasPrefix(".tmp-") }, "pre-commit crash did not preserve its owned temporary record")

        let restarted = FileClientInstanceStore(testRoot: root)
        try restarted.create(instance)
        try expect(try restarted.read(profile: instance.profile) == instance, "restart did not recover from a pre-commit crash")
        let record = root.appendingPathComponent(instance.instanceID.value + ".json")
        try expect(try linkCount(record) == 1, "exclusive atomic create left a multi-link final record")
        try expectError(.duplicateProfile, "atomic recovery weakened no-overwrite semantics") { try restarted.create(instance) }

        let secondRoot = FileManager.default.temporaryDirectory.appendingPathComponent("triangle-client-postcommit-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: secondRoot) }
        let afterCommit = FileClientInstanceStore(testRoot: secondRoot, simulatedCrashAt: .afterExclusiveRename)
        try expectError(.unsafeStorage, "simulated post-commit crash did not interrupt create") { try afterCommit.create(instance) }
        let secondRestart = FileClientInstanceStore(testRoot: secondRoot)
        try expect(try secondRestart.read(profile: instance.profile) == instance, "post-commit crash lost the committed record")
        try expect(try linkCount(secondRoot.appendingPathComponent(instance.instanceID.value + ".json")) == 1, "post-commit crash left link-count two")
    }

    public static func serializedTransitions() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("triangle-client-transitions-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let profile = try ProfileName("research")
        let instance = try ClientInstance(profile: profile, runtimeAdapter: .codex)
        let entered = DispatchSemaphore(value: 0)
        let release = DispatchSemaphore(value: 0)
        let setResult = LockedResultBox()
        let removeResult = LockedResultBox()
        let pausing = FileClientInstanceStore(testRoot: root) { point in
            if point == .setEnabledAfterRead {
                entered.signal()
                _ = release.wait(timeout: .now() + 5)
            }
        }
        try pausing.create(instance)

        let setThread = Thread {
            setResult.capture { try pausing.setEnabled(false, profile: profile) }
        }
        setThread.start()
        try expect(entered.wait(timeout: .now() + 5) == .success, "setEnabled did not reach its deterministic pause")
        let remover = FileClientInstanceStore(testRoot: root)
        let removeStarted = DispatchSemaphore(value: 0)
        let removeFinished = DispatchSemaphore(value: 0)
        let removeThread = Thread {
            removeStarted.signal()
            removeResult.capture { try remover.remove(profile: profile) }
            removeFinished.signal()
        }
        removeThread.start()
        try expect(removeStarted.wait(timeout: .now() + 5) == .success, "remove thread did not start")
        try expect(removeFinished.wait(timeout: .now() + 0.1) == .timedOut, "remove bypassed the full setEnabled transition lock")
        release.signal()
        try expect(removeFinished.wait(timeout: .now() + 5) == .success, "serialized remove did not finish")
        try setResult.get(); try removeResult.get()
        try expectError(.notFound, "stale setEnabled resurrected a removed record") { _ = try remover.read(profile: profile) }

        let createEntered = DispatchSemaphore(value: 0)
        let createRelease = DispatchSemaphore(value: 0)
        let firstCreateResult = LockedResultBox()
        let secondCreateResult = LockedResultBox()
        let first = FileClientInstanceStore(testRoot: root) { point in
            if point == .createBeforeCommit {
                createEntered.signal()
                _ = createRelease.wait(timeout: .now() + 5)
            }
        }
        let firstThread = Thread { firstCreateResult.capture { try first.create(instance) } }
        firstThread.start()
        try expect(createEntered.wait(timeout: .now() + 5) == .success, "create did not reach its deterministic pause")
        let second = FileClientInstanceStore(testRoot: root)
        let secondFinished = DispatchSemaphore(value: 0)
        let secondThread = Thread {
            secondCreateResult.capture { try second.create(instance) }
            secondFinished.signal()
        }
        secondThread.start()
        try expect(secondFinished.wait(timeout: .now() + 0.1) == .timedOut, "concurrent create bypassed the transition lock")
        createRelease.signal()
        try expect(secondFinished.wait(timeout: .now() + 5) == .success, "second create did not finish")
        try firstCreateResult.get()
        try expectError(.duplicateProfile, "concurrent create overwrote the winner") { try secondCreateResult.get() }
        try expect(try second.read(profile: profile).runtimeAdapter == .codex, "concurrent create corrupted the winner")
    }

    public static func unsafeMetadataRefusal() throws {
        let manager = FileManager.default
        let unsafeDirectory = manager.temporaryDirectory.appendingPathComponent("triangle-client-unsafe-dir-\(UUID().uuidString)")
        try manager.createDirectory(at: unsafeDirectory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o755])
        defer { try? manager.removeItem(at: unsafeDirectory) }
        try manager.setAttributes([.posixPermissions: 0o755], ofItemAtPath: unsafeDirectory.path)
        try expectError(.unsafeStorage, "mode-0755 instance directory was accepted") {
            _ = try FileClientInstanceStore(testRoot: unsafeDirectory).list()
        }

        try withStore { store, root in
            let profile = try ProfileName("research")
            let instance = try ClientInstance(profile: profile, runtimeAdapter: .codex)
            try store.create(instance)
            let record = root.appendingPathComponent(instance.instanceID.value + ".json")
            try manager.setAttributes([.posixPermissions: 0o644], ofItemAtPath: record.path)
            try expectError(.unsafeStorage, "mode-0644 instance record was accepted") { _ = try store.read(profile: profile) }
        }

        let currentOwner = Int(getuid())
        try expect(FileClientInstanceStore.metadataIsSafe(mode: 0o700, owner: currentOwner, linkCount: 1, directory: true), "current owner directory metadata was rejected")
        try expect(!FileClientInstanceStore.metadataIsSafe(mode: 0o700, owner: currentOwner + 1, linkCount: 1, directory: true), "wrong-owner directory metadata was accepted")
        try expect(!FileClientInstanceStore.metadataIsSafe(mode: 0o600, owner: currentOwner + 1, linkCount: 1, directory: false), "wrong-owner file metadata was accepted")
    }

    public static func exactLifecycleAndCredentialPreservation() throws {
        try withStore { store, _ in
            let research = try ClientInstance(profile: ProfileName("research"), runtimeAdapter: .codex)
            let operations = try ClientInstance(profile: ProfileName("operations"), runtimeAdapter: .hermes)
            try store.create(research); try store.create(operations)
            try store.setEnabled(false, profile: research.profile)
            try expect(try store.read(profile: research.profile).enabled == false, "exact disable failed")
            try expect(try store.read(profile: operations.profile).enabled == true, "disable affected another profile")
            try store.setEnabled(true, profile: research.profile)
            try expect(try store.read(profile: research.profile).enabled, "exact enable failed")

            let credentials = InMemoryCredentialStore()
            let binding = try CredentialBinding(origin: MeshOrigin("https://thetriangle.dev"), agentID: AgentID("agent_" + String(repeating: "a", count: 32)), handle: MailboxHandle("research-agent"), token: MeshToken("mesh_" + String(repeating: "b", count: 64)))
            try credentials.create(binding, for: research.profile)
            try store.remove(profile: research.profile)
            try expectError(.notFound, "removed instance remained readable") { _ = try store.read(profile: research.profile) }
            try expect(try credentials.read(for: research.profile) == binding, "removing an instance deleted its credential")
            try expect(try store.read(profile: operations.profile) == operations, "remove affected another profile")
        }
    }

    private static func withStore(_ body: (FileClientInstanceStore, URL) throws -> Void) throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("triangle-client-instances-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        try body(FileClientInstanceStore(testRoot: root), root)
    }

    private static func mode(_ url: URL) throws -> Int {
        let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
        return (attributes[.posixPermissions] as? NSNumber)?.intValue ?? -1
    }

    private static func linkCount(_ url: URL) throws -> Int {
        let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
        return (attributes[.referenceCount] as? NSNumber)?.intValue ?? -1
    }

    private static func expectError(_ expected: ClientInstanceStoreError, _ message: String, _ body: () throws -> Void) throws {
        do { try body(); throw ClientInstanceContractFailure(message) }
        catch let error as ClientInstanceStoreError { try expect(error == expected, "\(message): \(error)") }
    }
}

private final class LockedResultBox: @unchecked Sendable {
    private let lock = NSLock()
    private var result: Result<Void, Error>?
    func capture(_ body: () throws -> Void) { lock.withLock { result = Result { try body() } } }
    func get() throws {
        let value = lock.withLock { result }
        guard let value else { throw ClientInstanceContractFailure("concurrent operation did not publish a result") }
        try value.get()
    }
}

private struct ClientInstanceContractFailure: Error { let message: String; init(_ message: String) { self.message = message } }
private func expect(_ condition: @autoclosure () throws -> Bool, _ message: String) throws {
    guard try condition() else { throw ClientInstanceContractFailure(message) }
}
