import CryptoKit
import Foundation
@_spi(EnrollmentTesting) @_spi(TriangleClientTesting) import TriangleMailboxCore

public enum TriangleClientCLIContractCases {
    public struct ContractCase: Sendable {
        public let name: String
        public let run: @Sendable () async throws -> Void
    }

    public static let all: [ContractCase] = [
        .init(name: "client parser accepts only explicit closed agent lifecycle commands", run: parserIsClosed),
        .init(name: "clean-machine first agent add verifies then activates through the lifecycle seam", run: addVerifiesBeforeMutation),
        .init(name: "duplicate and cross-runtime profile reuse are rejected", run: duplicateReuseRejected),
        .init(name: "agent lifecycle targets exact profiles and preserves credentials", run: lifecyclePreservesCredentials),
        .init(name: "lifecycle reload failure restores the exact prior registry", run: reloadFailureRollsBack),
        .init(name: "rollback reload failure is surfaced explicitly", run: rollbackFailureIsExplicit),
        .init(name: "disable and remove reload without stale polling before cleanup", run: stopPollingBeforeCleanup),
        .init(name: "enable verifies the exact disabled profile before mutation", run: enableReverifiesTarget),
        .init(name: "remove cleanup failure is explicit and preserves credentials", run: cleanupFailurePreservesCredential),
        .init(name: "file cleanup removes only opaque instance roots and rejects symlinks", run: fileCleanupIsConfined),
        .init(name: "file cleanup remains confined when an intermediate path is swapped", run: fileCleanupResistsIntermediateSwap),
        .init(name: "client output is stable sanitized JSON", run: outputIsSanitized),
        .init(name: "launchd cutover waits for PID stability and activates only after legacy retirement", run: launchdCutoverIsTwoPhase),
        .init(name: "launchd rollback never restores legacy while the client may still be loaded", run: launchdRollbackAvoidsDuplicates),
        .init(name: "set-delivery-mode reloads worker eligibility without touching credentials", run: setDeliveryModeReloadsWorkerEligibility),
    ]

    public static func parserIsClosed() async throws {
        let alpha = try ProfileName("alpha")
        let parsedAdd = try TriangleClientCommandParser.parse(["agent", "add", "--profile", "alpha", "--runtime", "codex"])
        let parsedList = try TriangleClientCommandParser.parse(["agent", "list"])
        let parsedStatus = try TriangleClientCommandParser.parse(["agent", "status", "--profile", "alpha"])
        let parsedEnable = try TriangleClientCommandParser.parse(["agent", "enable", "--profile", "alpha"])
        let parsedDisable = try TriangleClientCommandParser.parse(["agent", "disable", "--profile", "alpha"])
        let parsedRemove = try TriangleClientCommandParser.parse(["agent", "remove", "--profile", "alpha"])
        let parsedDeliveryMode = try TriangleClientCommandParser.parse([
            "agent", "set-delivery-mode", "--profile", "alpha", "--mode", "mcp-interactive",
        ])
        try clientExpect(parsedAdd == .add(profile: alpha, adapter: .codex), "add did not parse")
        try clientExpect(parsedList == .list, "list did not parse")
        try clientExpect(parsedStatus == .status(profile: alpha), "status did not parse")
        try clientExpect(parsedEnable == .enable(profile: alpha), "enable did not parse")
        try clientExpect(parsedDisable == .disable(profile: alpha), "disable did not parse")
        try clientExpect(parsedRemove == .remove(profile: alpha), "remove did not parse")
        try clientExpect(parsedDeliveryMode == .setDeliveryMode(profile: alpha, mode: .mcpInteractive), "set-delivery-mode did not parse")

        let rejected = [
            ["agent", "add", "--adapter", "codex"],
            ["agent", "add", "--profile", "alpha"],
            ["agent", "add", "--profile", "alpha", "--adapter", "codex"],
            ["agent", "add", "--profile", "alpha", "--runtime", "openrouter"],
            ["agent", "status"], ["agent", "list", "--profile", "alpha"],
            ["agent", "delete-credential", "--profile", "alpha"],
            ["agent", "remove", "--profile", "alpha", "--delete-credential"],
            ["agent", "run", "--profile", "alpha", "--command", "/bin/sh"],
            ["agent", "set-delivery-mode", "--profile", "alpha"],
            ["agent", "set-delivery-mode", "--profile", "alpha", "--mode", "socket"],
            ["status", "--profile", "alpha"], ["agent", "enable", "--profile", "alpha", "--force"],
        ]
        for arguments in rejected {
            do { _ = try TriangleClientCommandParser.parse(arguments); throw TriangleClientContractFailure("accepted unsafe arguments: \(arguments)") }
            catch is TriangleClientCommandParseError {}
        }
    }

    public static func addVerifiesBeforeMutation() async throws {
        let fixture = try Fixture()
        let service = fixture.service(readiness: { instance in
            fixture.events.append("runtime:\(instance.runtimeAdapter.rawValue)")
        })
        _ = try await service.execute(.add(profile: fixture.profile, adapter: .codex))
        try clientExpect(fixture.events.values == ["credential", "runtime:codex", "create"], "add mutation occurred before verification/readiness: \(fixture.events.values)")
        try clientExpect(fixture.serviceControl.reloadCount == 1, "first add did not activate the staged client")
        try clientExpect(fixture.serviceControl.snapshots == [["alpha-profile:true:worker"]], "first activation did not use the exact committed profile")

        let failed = try Fixture()
        let failing = failed.service(readiness: { _ in throw TriangleClientOperationError.runtimeUnavailable })
        do { _ = try await failing.execute(.add(profile: failed.profile, adapter: .codex)); throw TriangleClientContractFailure("unready runtime was added") }
        catch TriangleClientOperationError.runtimeUnavailable {}
        let remaining = try failed.instances.list()
        try clientExpect(remaining.isEmpty, "failed add mutated the registry")
    }

    public static func duplicateReuseRejected() async throws {
        let fixture = try Fixture()
        let service = fixture.service()
        _ = try await service.execute(.add(profile: fixture.profile, adapter: .codex))
        for adapter in [RuntimeAdapter.codex, .hermes, .antigravity] {
            do { _ = try await service.execute(.add(profile: fixture.profile, adapter: adapter)); throw TriangleClientContractFailure("duplicate profile was accepted") }
            catch ClientInstanceStoreError.duplicateProfile {}
        }
        let registered = try fixture.instances.read(profile: fixture.profile)
        try clientExpect(registered.runtimeAdapter == .codex, "duplicate rebound the runtime")
    }

    public static func lifecyclePreservesCredentials() async throws {
        let fixture = try Fixture()
        let service = fixture.service()
        _ = try await service.execute(.add(profile: fixture.profile, adapter: .hermes))
        _ = try await service.execute(.disable(profile: fixture.profile))
        let disabled = try fixture.instances.read(profile: fixture.profile)
        try clientExpect(disabled.enabled == false, "disable targeted the wrong record")
        _ = try await service.execute(.enable(profile: fixture.profile))
        let enabled = try fixture.instances.read(profile: fixture.profile)
        try clientExpect(enabled.enabled, "enable targeted the wrong record")
        _ = try await service.execute(.remove(profile: fixture.profile))
        try clientExpect(fixture.credentials.deleteCount == 0, "remove deleted the credential")
        _ = try fixture.credentials.read(for: fixture.profile)
    }

    public static func reloadFailureRollsBack() async throws {
        let addFixture = try Fixture(serviceFailures: [1])
        do { _ = try await addFixture.service().execute(.add(profile: addFixture.profile, adapter: .codex)); throw TriangleClientContractFailure("failed reload reported success") }
        catch TriangleClientLifecycleError.reloadFailed {}
        let afterAddFailure = try addFixture.instances.list()
        try clientExpect(afterAddFailure.isEmpty, "failed add reload left the new registry record")
        try clientExpect(addFixture.serviceControl.reloadCount == 2, "failed add did not reload the restored registry")

        let disableFixture = try Fixture()
        let service = disableFixture.service()
        _ = try await service.execute(.add(profile: disableFixture.profile, adapter: .codex))
        disableFixture.serviceControl.fail(onReloads: [2])
        do { _ = try await service.execute(.disable(profile: disableFixture.profile)); throw TriangleClientContractFailure("failed disable reload reported success") }
        catch TriangleClientLifecycleError.reloadFailed {}
        let afterDisableFailure = try disableFixture.instances.read(profile: disableFixture.profile)
        try clientExpect(afterDisableFailure.enabled, "failed disable reload did not restore enabled state")
        try clientExpect(disableFixture.serviceControl.reloadCount == 3, "failed disable did not verify restored config")
    }

    public static func rollbackFailureIsExplicit() async throws {
        let fixture = try Fixture(serviceFailures: [1, 2])
        do { _ = try await fixture.service().execute(.add(profile: fixture.profile, adapter: .codex)); throw TriangleClientContractFailure("double reload failure reported success") }
        catch TriangleClientLifecycleError.rollbackFailed {}
        let afterRollbackFailure = try fixture.instances.list()
        try clientExpect(afterRollbackFailure.isEmpty, "registry rollback itself was not applied")
    }

    public static func stopPollingBeforeCleanup() async throws {
        let fixture = try Fixture()
        let service = fixture.service()
        _ = try await service.execute(.add(profile: fixture.profile, adapter: .hermes))
        _ = try await service.execute(.disable(profile: fixture.profile))
        try clientExpect(fixture.serviceControl.snapshots.last == ["alpha-profile:false:worker"], "disable reloaded a stale enabled registry")
        _ = try await service.execute(.enable(profile: fixture.profile))
        _ = try await service.execute(.remove(profile: fixture.profile))
        try clientExpect(fixture.serviceControl.snapshots.last == [], "remove did not reload the profile-free config")
        try clientExpect(fixture.cleaner.cleaned == [ClientInstanceID.derive(profile: fixture.profile)], "remove did not clean the exact opaque instance")
        try clientExpect(fixture.cleaner.reloadCountAtCleanup == fixture.serviceControl.reloadCount, "mutable state was cleaned before the stop reload completed")
    }

    public static func cleanupFailurePreservesCredential() async throws {
        let fixture = try Fixture(cleanupFails: true)
        let service = fixture.service()
        _ = try await service.execute(.add(profile: fixture.profile, adapter: .codex))
        do { _ = try await service.execute(.remove(profile: fixture.profile)); throw TriangleClientContractFailure("cleanup failure reported success") }
        catch TriangleClientLifecycleError.cleanupFailed {}
        let afterCleanupFailure = try fixture.instances.list()
        try clientExpect(afterCleanupFailure.isEmpty, "cleanup failure restored stale polling")
        try clientExpect(fixture.credentials.deleteCount == 0, "cleanup failure touched the credential")
        _ = try fixture.credentials.read(for: fixture.profile)
    }

    public static func enableReverifiesTarget() async throws {
        let runtimeFixture = try Fixture()
        let setup = runtimeFixture.service()
        _ = try await setup.execute(.add(profile: runtimeFixture.profile, adapter: .codex))
        _ = try await setup.execute(.disable(profile: runtimeFixture.profile))
        let healthy = try ClientInstance(profile: ProfileName("healthy-peer"), runtimeAdapter: .hermes)
        try runtimeFixture.instances.create(healthy)
        let reloadsBeforeRuntimeFailure = runtimeFixture.serviceControl.reloadCount
        let runtimeUnavailable = runtimeFixture.service { instance in
            if instance.profile == runtimeFixture.profile { throw TriangleClientOperationError.runtimeUnavailable }
        }
        do { _ = try await runtimeUnavailable.execute(.enable(profile: runtimeFixture.profile)); throw TriangleClientContractFailure("enable accepted unavailable target runtime") }
        catch TriangleClientOperationError.runtimeUnavailable {}
        let afterRuntimeFailure = try runtimeFixture.instances.read(profile: runtimeFixture.profile)
        try clientExpect(afterRuntimeFailure.enabled == false, "runtime failure mutated target state")
        try clientExpect(runtimeFixture.serviceControl.reloadCount == reloadsBeforeRuntimeFailure, "runtime failure reloaded aggregate healthy service")

        let credentialFixture = try Fixture()
        let credentialSetup = credentialFixture.service()
        _ = try await credentialSetup.execute(.add(profile: credentialFixture.profile, adapter: .codex))
        _ = try await credentialSetup.execute(.disable(profile: credentialFixture.profile))
        try credentialFixture.instances.create(healthy)
        try credentialFixture.credentials.delete(for: credentialFixture.profile)
        let reloadsBeforeCredentialFailure = credentialFixture.serviceControl.reloadCount
        do { _ = try await credentialSetup.execute(.enable(profile: credentialFixture.profile)); throw TriangleClientContractFailure("enable accepted missing target credential") }
        catch VerifiedCredentialGateError.profileStateInconsistent {}
        let afterCredentialFailure = try credentialFixture.instances.read(profile: credentialFixture.profile)
        try clientExpect(afterCredentialFailure.enabled == false, "credential failure mutated target state")
        try clientExpect(credentialFixture.serviceControl.reloadCount == reloadsBeforeCredentialFailure, "credential failure reloaded aggregate healthy service")
    }

    public static func fileCleanupIsConfined() async throws {
        let manager = FileManager.default
        let home = manager.temporaryDirectory.resolvingSymlinksInPath().appendingPathComponent("triangle-client-cleaner-\(UUID().uuidString)", isDirectory: true)
        defer { try? manager.removeItem(at: home) }
        let applicationInstances = home.appendingPathComponent("Library/Application Support/The Triangle/model-state/instances", isDirectory: true)
        let cacheInstances = home.appendingPathComponent("Library/Caches/The Triangle/instances", isDirectory: true)
        for root in [applicationInstances, cacheInstances] {
            try manager.createDirectory(at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            var cursor = home
            for component in root.pathComponents.dropFirst(home.pathComponents.count) { cursor.appendPathComponent(component); try manager.setAttributes([.posixPermissions: 0o700], ofItemAtPath: cursor.path) }
        }
        let identifier = ClientInstanceID.derive(profile: try ProfileName("clean-me"))
        let adjacent = try ClientInstance(profile: ProfileName("keep-me"), runtimeAdapter: .codex).instanceID
        for root in [applicationInstances, cacheInstances] {
            try manager.createDirectory(at: root.appendingPathComponent(identifier.value), withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
            try manager.createDirectory(at: root.appendingPathComponent(adjacent.value), withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        }
        let cleaner = FileTriangleClientMutableStateCleaner(home: home)
        try cleaner.removeMutableState(for: identifier)
        for root in [applicationInstances, cacheInstances] {
            try clientExpect(!manager.fileExists(atPath: root.appendingPathComponent(identifier.value).path), "target mutable root survived cleanup")
            try clientExpect(manager.fileExists(atPath: root.appendingPathComponent(adjacent.value).path), "adjacent instance was deleted")
        }

        let outside = home.appendingPathComponent("outside", isDirectory: true)
        try manager.createDirectory(at: outside, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        try manager.createSymbolicLink(at: applicationInstances.appendingPathComponent(identifier.value), withDestinationURL: outside)
        do { try cleaner.removeMutableState(for: identifier); throw TriangleClientContractFailure("symlink mutable root was accepted") }
        catch TriangleClientLifecycleError.cleanupFailed {}
        try clientExpect(manager.fileExists(atPath: outside.path), "cleanup followed a symlink outside its root")

        try manager.removeItem(at: applicationInstances.appendingPathComponent(identifier.value))
        let cacheTriangle = home.appendingPathComponent("Library/Caches/The Triangle", isDirectory: true)
        try manager.removeItem(at: cacheTriangle)
        let redirected = home.appendingPathComponent("redirected-cache", isDirectory: true)
        try manager.createDirectory(at: redirected.appendingPathComponent("instances/\(identifier.value)"), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try manager.createSymbolicLink(at: cacheTriangle, withDestinationURL: redirected)
        do { try cleaner.removeMutableState(for: identifier); throw TriangleClientContractFailure("intermediate cache symlink was accepted") }
        catch TriangleClientLifecycleError.cleanupFailed {}
        try clientExpect(manager.fileExists(atPath: redirected.appendingPathComponent("instances/\(identifier.value)").path), "cleanup escaped through intermediate cache symlink")

        try manager.removeItem(at: cacheTriangle)
        let applicationTriangle = home.appendingPathComponent("Library/Application Support/The Triangle", isDirectory: true)
        try manager.removeItem(at: applicationTriangle)
        let redirectedApplication = home.appendingPathComponent("redirected-application", isDirectory: true)
        let redirectedModel = redirectedApplication.appendingPathComponent("model-state/instances/\(identifier.value)", isDirectory: true)
        try manager.createDirectory(at: redirectedModel, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try manager.createSymbolicLink(at: applicationTriangle, withDestinationURL: redirectedApplication)
        do { try cleaner.removeMutableState(for: identifier); throw TriangleClientContractFailure("intermediate application symlink was accepted") }
        catch TriangleClientLifecycleError.cleanupFailed {}
        try clientExpect(manager.fileExists(atPath: redirectedModel.path), "cleanup escaped through intermediate application symlink")
    }

    public static func fileCleanupResistsIntermediateSwap() async throws {
        let manager = FileManager.default
        let home = manager.temporaryDirectory.resolvingSymlinksInPath().appendingPathComponent("triangle-client-cleaner-race-\(UUID().uuidString)", isDirectory: true)
        defer { try? manager.removeItem(at: home) }
        let triangle = home.appendingPathComponent("Library/Application Support/The Triangle", isDirectory: true)
        let original = home.appendingPathComponent("Library/Application Support/The Triangle-original", isDirectory: true)
        let instances = triangle.appendingPathComponent("model-state/instances", isDirectory: true)
        let identifier = ClientInstanceID.derive(profile: try ProfileName("race-target"))
        let target = instances.appendingPathComponent(identifier.value, isDirectory: true)
        try manager.createDirectory(at: target, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        var cursor = home
        for component in target.deletingLastPathComponent().pathComponents.dropFirst(home.pathComponents.count) { cursor.appendPathComponent(component); try manager.setAttributes([.posixPermissions: 0o700], ofItemAtPath: cursor.path) }
        try manager.setAttributes([.posixPermissions: 0o700], ofItemAtPath: target.path)
        let outside = home.appendingPathComponent("outside", isDirectory: true)
        let outsideTarget = outside.appendingPathComponent("model-state/instances/\(identifier.value)", isDirectory: true)
        try manager.createDirectory(at: outsideTarget, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let swap = OneShot()
        let cleaner = FileTriangleClientMutableStateCleaner(home: home) { root in
            guard root.path.contains("Application Support"), swap.take() else { return }
            try FileManager.default.moveItem(at: triangle, to: original)
            try FileManager.default.createSymbolicLink(at: triangle, withDestinationURL: outside)
        }
        try cleaner.removeMutableState(for: identifier)
        try clientExpect(manager.fileExists(atPath: outsideTarget.path), "cleanup race escaped into swapped outside root")
        try clientExpect(!manager.fileExists(atPath: original.appendingPathComponent("model-state/instances/\(identifier.value)").path), "retained descriptor did not clean original root")
    }

    public static func outputIsSanitized() async throws {
        let fixture = try Fixture()
        let service = fixture.service()
        let added = try await service.execute(.add(profile: fixture.profile, adapter: .codex))
        let listed = try await service.execute(.list)
        let status = try await service.execute(.status(profile: fixture.profile))
        let token = fixture.token
        for output in [added, listed, status] {
            try clientExpect(output.last == 0x0a, "JSON output is not newline terminated")
            let text = String(decoding: output, as: UTF8.self)
            try clientExpect(!text.contains(token) && !text.lowercased().contains("token") && !text.contains("Bearer"), "output exposed credential material")
            _ = try JSONSerialization.jsonObject(with: output)
        }
        try clientExpect(String(decoding: listed, as: UTF8.self).contains("\"agents\""), "list schema changed")
    }

    public static func setDeliveryModeReloadsWorkerEligibility() async throws {
        let fixture = try Fixture()
        let service = fixture.service()
        _ = try await service.execute(.add(profile: fixture.profile, adapter: .codex))
        _ = try await service.execute(.setDeliveryMode(profile: fixture.profile, mode: .mcpInteractive))
        try clientExpect(fixture.serviceControl.snapshots.last == ["alpha-profile:true:mcp-interactive"], "mcp-interactive mode did not stop worker polling")
        _ = try await service.execute(.setDeliveryMode(profile: fixture.profile, mode: .worker))
        try clientExpect(fixture.serviceControl.snapshots.last == ["alpha-profile:true:worker"], "worker mode did not restore polling eligibility")
        try clientExpect(fixture.credentials.deleteCount == 0, "delivery mode change touched credentials")
    }

    public static func launchdCutoverIsTwoPhase() async throws {
        let healthy = try LaunchdFixture()
        try healthy.loadLegacy("dev.thetriangle.codex.worker")
        do { try healthy.control.applyAndVerify(shouldRun: true) }
        catch {
            let log = (try? String(contentsOf: healthy.home.appendingPathComponent("launchctl.log"), encoding: .utf8)) ?? "<none>"
            throw TriangleClientContractFailure("healthy two-phase cutover failed: \(error); calls=\(log)")
        }
        try clientExpect(healthy.loaded("dev.thetriangle.client"), "healthy client was not left loaded")
        try clientExpect(!healthy.loaded("dev.thetriangle.codex.worker"), "legacy consumer remained loaded after activation")
        let activation = try JSONSerialization.jsonObject(with: Data(contentsOf: healthy.activationMarker)) as? [String: Any]
        try clientExpect(activation?["generation"] as? String == LaunchdFixture.generation, "activation did not bind the ready generation")
        try healthy.control.applyAndVerify(shouldRun: false)
        try clientExpect(!FileManager.default.fileExists(atPath: healthy.activationMarker.path), "stopped client retained its activation marker")
        try clientExpect(!FileManager.default.fileExists(atPath: healthy.readinessMarker.path), "stopped client retained its readiness marker")

        let crashing = try LaunchdFixture()
        try crashing.loadLegacy("dev.thetriangle.codex.worker")
        FileManager.default.createFile(atPath: crashing.home.appendingPathComponent("crash-after-ready").path, contents: Data())
        do { try crashing.control.applyAndVerify(shouldRun: true); throw TriangleClientContractFailure("crash-loop passed the PID stability gate") }
        catch TriangleClientLifecycleError.reloadFailed {}
        try clientExpect(!crashing.loaded("dev.thetriangle.client"), "unstable client survived rollback")
        try clientExpect(crashing.loaded("dev.thetriangle.codex.worker"), "unstable client retired the legacy consumer")
        try clientExpect(!FileManager.default.fileExists(atPath: crashing.activationMarker.path), "successful rollback retained activation")
        try clientExpect(!FileManager.default.fileExists(atPath: crashing.readinessMarker.path), "successful rollback retained readiness")
    }

    public static func launchdRollbackAvoidsDuplicates() async throws {
        for seam in ["fail-client-bootout", "sticky-client-bootout"] {
            let fixture = try LaunchdFixture()
            try fixture.loadLegacy("dev.thetriangle.codex.worker")
            try fixture.loadLegacy("dev.thetriangle.hermes.worker")
            FileManager.default.createFile(atPath: fixture.home.appendingPathComponent("fail-hermes-bootout").path, contents: Data())
            FileManager.default.createFile(atPath: fixture.home.appendingPathComponent(seam).path, contents: Data())
            do { try fixture.control.applyAndVerify(shouldRun: true); throw TriangleClientContractFailure("\(seam) rollback reported success") }
            catch TriangleClientLifecycleError.rollbackFailed {}
            try clientExpect(fixture.loaded("dev.thetriangle.client"), "\(seam) fixture did not retain the unproven client")
            try clientExpect(!fixture.loaded("dev.thetriangle.codex.worker"), "\(seam) reactivated a retired legacy consumer beside the client")
            try clientExpect(fixture.loaded("dev.thetriangle.hermes.worker"), "\(seam) changed the still-loaded legacy consumer")
        }
    }
}

private final class LaunchdFixture {
    static let generation = "11111111-1111-4111-8111-111111111111"
    let home: URL
    let state: URL
    let activationMarker: URL
    let readinessMarker: URL
    let control: LaunchdTriangleClientServiceControl

    init() throws {
        let manager = FileManager.default
        home = manager.temporaryDirectory.resolvingSymlinksInPath().appendingPathComponent("triangle-launchd-\(UUID().uuidString)", isDirectory: true)
        state = home.appendingPathComponent("state", isDirectory: true)
        let application = home.appendingPathComponent("Library/Application Support/The Triangle", isDirectory: true)
        let client = application.appendingPathComponent("client", isDirectory: true)
        let bin = application.appendingPathComponent("bin", isDirectory: true)
        let installManifest = application.appendingPathComponent("install-manifest", isDirectory: true)
        let launchAgents = home.appendingPathComponent("Library/LaunchAgents", isDirectory: true)
        let logs = home.appendingPathComponent("Library/Logs/the-triangle", isDirectory: true)
        for directory in [home, state, application, client, bin, installManifest, launchAgents, logs] {
            try manager.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            try manager.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)
        }
        activationMarker = client.appendingPathComponent("activate.json")
        readinessMarker = client.appendingPathComponent("ready.json")
        let helper = bin.appendingPathComponent("triangle-mailbox")
        let helperData = Data("#!/bin/sh\nexit 0\n".utf8)
        try helperData.write(to: helper, options: .atomic)
        try manager.setAttributes([.posixPermissions: 0o700], ofItemAtPath: helper.path)
        let digest = SHA256.hash(data: helperData).map { String(format: "%02x", $0) }.joined()
        let hash = installManifest.appendingPathComponent("triangle-mailbox.sha256")
        try Data("\(digest)\n".utf8).write(to: hash, options: .atomic)
        try manager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: hash.path)
        try Self.writeClientPlist(home: home, helper: helper)
        let executable = home.appendingPathComponent("launchctl")
        try Data(Self.launchctlScript.utf8).write(to: executable, options: .atomic)
        try manager.setAttributes([.posixPermissions: 0o700], ofItemAtPath: executable.path)
        control = LaunchdTriangleClientServiceControl(executableURL: executable, home: home, readinessTimeoutMilliseconds: 250, stabilityMilliseconds: 40)
    }

    deinit { try? FileManager.default.removeItem(at: home) }
    func loaded(_ label: String) -> Bool { FileManager.default.fileExists(atPath: state.appendingPathComponent(label).path) }
    func loadLegacy(_ label: String) throws {
        let plist = home.appendingPathComponent("Library/LaunchAgents/\(label).plist")
        let document: [String: Any] = ["Label": label]
        try PropertyListSerialization.data(fromPropertyList: document, format: .xml, options: 0).write(to: plist)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: plist.path)
        FileManager.default.createFile(atPath: state.appendingPathComponent(label).path, contents: Data())
    }

    private static func writeClientPlist(home: URL, helper: URL) throws {
        let logs = home.appendingPathComponent("Library/Logs/the-triangle")
        let document: [String: Any] = [
            "Label": "dev.thetriangle.client",
            "ProgramArguments": [helper.path, "run-supervisor"],
            "RunAtLoad": true,
            "KeepAlive": true,
            "ThrottleInterval": 10,
            "StandardOutPath": logs.appendingPathComponent("client.log").path,
            "StandardErrorPath": logs.appendingPathComponent("client.error.log").path,
        ]
        let plist = home.appendingPathComponent("Library/LaunchAgents/dev.thetriangle.client.plist")
        try PropertyListSerialization.data(fromPropertyList: document, format: .xml, options: 0).write(to: plist)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: plist.path)
    }

    private static let launchctlScript = #"""
#!/bin/bash
set -eu
/usr/bin/printf '%s\n' "$*" >> "$HOME/launchctl.log"
command=$1
target=${2:-}
if [[ "$command" == kickstart ]]; then target=${3:-}; fi
label=${target##*/}
state="$HOME/state"
if [[ "$command" == bootstrap ]]; then
  plist=$3
  label=$(/usr/bin/basename "$plist" .plist)
  /usr/bin/touch "$state/$label"
  if [[ "$label" == dev.thetriangle.client ]]; then
    now=$(/usr/bin/python3 -c 'import time; print(int(time.time()*1000))')
    /usr/bin/printf '{"version":1,"generation":"11111111-1111-4111-8111-111111111111","parentPid":4242,"configDigest":"%064d","readyAtMilliseconds":%s}\n' 0 "$now" > "$HOME/Library/Application Support/The Triangle/client/ready.json"
    /bin/chmod 600 "$HOME/Library/Application Support/The Triangle/client/ready.json"
  fi
elif [[ "$command" == kickstart ]]; then
  /usr/bin/touch "$state/$label"
elif [[ "$command" == bootout ]]; then
  if [[ "$label" == dev.thetriangle.client && -e "$HOME/fail-client-bootout" ]]; then exit 72; fi
  if [[ "$label" == dev.thetriangle.client && -e "$HOME/sticky-client-bootout" ]]; then exit 0; fi
  if [[ "$label" == dev.thetriangle.hermes.worker && -e "$HOME/fail-hermes-bootout" ]]; then exit 72; fi
  /bin/rm -f "$state/$label"
elif [[ "$command" == print ]]; then
  [[ -e "$state/$label" ]] || exit 113
  if [[ "$label" == dev.thetriangle.client ]]; then
    if [[ -e "$HOME/crash-after-ready" && -e "$state/.printed-client" ]]; then /bin/rm -f "$state/$label"; exit 113; fi
    /usr/bin/touch "$state/.printed-client"
    /usr/bin/printf 'state = running\npid = 4242\n'
  fi
fi
"""#
}

private final class Fixture: @unchecked Sendable {
    let profile = try! ProfileName("alpha-profile")
    let token = "mesh_" + String(repeating: "7", count: 64)
    let instances: RecordingInstanceStore
    let credentials: RecordingCredentialStore
    let events = EventRecorder()
    let gate: VerifiedCredentialGate
    let serviceControl: RecordingServiceControl
    let cleaner: RecordingStateCleaner

    init(serviceFailures: Set<Int> = [], cleanupFails: Bool = false) throws {
        instances = RecordingInstanceStore(events: events)
        credentials = RecordingCredentialStore(events: events)
        serviceControl = RecordingServiceControl(instances: instances, failures: serviceFailures)
        cleaner = RecordingStateCleaner(serviceControl: serviceControl, fails: cleanupFails)
        let origin = try MeshOrigin("https://thetriangle.dev")
        let agentID = try AgentID("agent_" + String(repeating: "a", count: 32))
        let handle = try MailboxHandle("alpha-profile")
        try credentials.create(CredentialBinding(origin: origin, agentID: agentID, handle: handle, token: try MeshToken(token)), for: profile)
        let journal = InMemoryEnrollmentJournal()
        try journal.write(.testing(profile: profile, origin: origin, state: .verified, agentID: agentID, handle: handle, reasonCode: "identity_verified"))
        gate = VerifiedCredentialGate(store: credentials, transport: IdentityTransport(), reservation: InMemoryEnrollmentReservation(), journal: journal)
        credentials.resetObservations()
    }

    func service(readiness: @escaping @Sendable (ClientInstance) throws -> Void = { _ in }) -> TriangleClientAgentService {
        TriangleClientAgentService(instanceStore: instances, credentialGate: gate, runtimeReadiness: readiness, serviceControl: serviceControl, stateCleaner: cleaner, lifecycleLock: InMemoryLifecycleLock())
    }
}

private final class RecordingInstanceStore: ClientInstanceStore, @unchecked Sendable {
    private let backing = InMemoryClientInstanceStore(); private let events: EventRecorder
    init(events: EventRecorder) { self.events = events }
    func create(_ instance: ClientInstance) throws { events.append("create"); try backing.create(instance) }
    func read(profile: ProfileName) throws -> ClientInstance { try backing.read(profile: profile) }
    func list() throws -> [ClientInstance] { try backing.list() }
    func setEnabled(_ enabled: Bool, profile: ProfileName) throws { try backing.setEnabled(enabled, profile: profile) }
    func setDeliveryMode(_ deliveryMode: DeliveryMode, profile: ProfileName) throws { try backing.setDeliveryMode(deliveryMode, profile: profile) }
    func remove(profile: ProfileName) throws { try backing.remove(profile: profile) }
}
private final class RecordingCredentialStore: CredentialStore, @unchecked Sendable {
    private let backing = InMemoryCredentialStore(); private let events: EventRecorder; private(set) var deleteCount = 0; private var observe = false
    init(events: EventRecorder) { self.events = events }
    func resetObservations() { observe = true }
    func create(_ binding: CredentialBinding, for profile: ProfileName) throws { try backing.create(binding, for: profile) }
    func read(for profile: ProfileName) throws -> CredentialBinding { if observe { events.append("credential") }; return try backing.read(for: profile) }
    func replace(_ binding: CredentialBinding, for profile: ProfileName, confirmation: CredentialReplacementConfirmation) throws { try backing.replace(binding, for: profile, confirmation: confirmation) }
    func delete(for profile: ProfileName) throws { deleteCount += 1; try backing.delete(for: profile) }
}
private final class EventRecorder: @unchecked Sendable { private let lock = NSLock(); private var storage: [String] = []; var values: [String] { lock.withLock { storage } }; func append(_ value: String) { lock.withLock { storage.append(value) } } }
private final class OneShot: @unchecked Sendable { private let lock = NSLock(); private var available = true; func take() -> Bool { lock.withLock { let result = available; available = false; return result } } }
private final class RecordingServiceControl: TriangleClientServiceControlling, @unchecked Sendable {
    private let instances: RecordingInstanceStore; private let lock = NSLock(); private var failures: Set<Int>; private(set) var reloadCount = 0; private(set) var snapshots: [[String]] = []
    init(instances: RecordingInstanceStore, failures: Set<Int>) { self.instances = instances; self.failures = failures }
    func fail(onReloads values: Set<Int>) { lock.withLock { failures.formUnion(values) } }
    func applyAndVerify(shouldRun: Bool) throws {
        let count = lock.withLock { reloadCount += 1; return reloadCount }
        snapshots.append(try instances.list().map { "\($0.profile.value):\($0.enabled):\($0.deliveryMode.rawValue)" })
        let expected = try instances.list().contains(where: { $0.participatesInWorkerPolling })
        if shouldRun != expected { throw TriangleClientLifecycleError.reloadFailed }
        if lock.withLock({ failures.contains(count) }) { throw TriangleClientLifecycleError.reloadFailed }
    }
}
private final class RecordingStateCleaner: TriangleClientMutableStateCleaning, @unchecked Sendable {
    private let serviceControl: RecordingServiceControl; private let fails: Bool; private(set) var cleaned: [ClientInstanceID] = []; private(set) var reloadCountAtCleanup = 0
    init(serviceControl: RecordingServiceControl, fails: Bool) { self.serviceControl = serviceControl; self.fails = fails }
    func removeMutableState(for instanceID: ClientInstanceID) throws { cleaned.append(instanceID); reloadCountAtCleanup = serviceControl.reloadCount; if fails { throw TriangleClientLifecycleError.cleanupFailed } }
}
private final class InMemoryLifecycleLock: TriangleClientLifecycleLocking, @unchecked Sendable {
    private let semaphore = DispatchSemaphore(value: 1)
    func acquire() throws -> any TriangleClientLifecycleLease { semaphore.wait(); return InMemoryLifecycleLease(semaphore: semaphore) }
}
private final class InMemoryLifecycleLease: TriangleClientLifecycleLease, @unchecked Sendable {
    private let guardLock = NSLock(); private let semaphore: DispatchSemaphore; private var released = false
    init(semaphore: DispatchSemaphore) { self.semaphore = semaphore }
    func release() { guardLock.withLock { if !released { released = true; semaphore.signal() } } }
    deinit { release() }
}
private struct IdentityTransport: MeshTransport {
    func send(_ request: MeshHTTPRequest) async throws -> MeshHTTPResponse {
        let body = Data(#"{"agent":{"id":"agent_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","name":"Alpha","handle":"alpha-profile","registrationMode":"mailbox","endpointUrl":"https://thetriangle.dev/api/v1/mailbox"}}"#.utf8)
        return MeshHTTPResponse(statusCode: 200, headers: ["Content-Type": "application/json"], body: body, finalURL: request.url)
    }
}
private struct TriangleClientContractFailure: Error, CustomStringConvertible { let description: String; init(_ description: String) { self.description = description } }
private func clientExpect(_ condition: @autoclosure () -> Bool, _ message: String) throws { if !condition() { throw TriangleClientContractFailure(message) } }
