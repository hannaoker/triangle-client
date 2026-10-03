import Foundation

/// Writes the supervisor binding that admits a production Cursor ACP profile.
public enum CursorAcpRuntimeBinding {
    public static func ensure(for instance: ClientInstance) throws {
        guard instance.runtimeAdapter == .cursorAcp,
              instance.instanceID == .derive(profile: instance.profile)
        else { throw WorkerLauncherError.invalidManifest }

        let applicationRoot = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/The Triangle", isDirectory: true)
        let clientRoot = applicationRoot.appendingPathComponent("client", isDirectory: true)
        let installationID = try FileClientInstallationIdentityStore().resolve().value
        let command = try FileWorkerCommandResolver.cursorAgentExecutable().path
        let cursorHome = try directory(
            applicationRoot
                .appendingPathComponent("model-state", isDirectory: true)
                .appendingPathComponent("cursor-acp-runtime-home", isDirectory: true)
        )
        let workRoot = try directory(clientRoot.appendingPathComponent("cursor-acp-work", isDirectory: true))
        let stateRoot = try directory(
            clientRoot
                .appendingPathComponent("cursor-acp-state", isDirectory: true)
                .appendingPathComponent(instance.profile.value, isDirectory: true)
        )

        var profiles = (try? FileClientInstanceStore().list()) ?? []
        profiles = profiles.filter { $0.enabled && $0.runtimeAdapter == .cursorAcp && $0.profile != instance.profile }
        profiles.append(instance)

        let document: [String: Any] = [
            "version": 1,
            "common": [
                "adapterVersion": "1",
                "installationId": installationID,
                "workingDirectory": workRoot,
                "cursorHome": cursorHome,
                "command": command,
                "pollIntervalMs": 1_000,
            ],
            "profiles": profiles.map { member in
                [
                    "profile": member.profile.value,
                    "instanceId": member.instanceID.value,
                    "stateRoot": stateRootReplacing(clientRoot: clientRoot, profile: member.profile.value, fallback: stateRoot),
                    "shadowTestProfile": false,
                ]
            },
        ]
        let data = try JSONSerialization.data(withJSONObject: document, options: [.sortedKeys])
        let destination = clientRoot.appendingPathComponent("cursor-acp-runtime-binding.json")
        let temporary = clientRoot.appendingPathComponent(".tmp-cursor-acp-binding-\(UUID().uuidString)")
        try data.write(to: temporary, options: .withoutOverwriting)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: temporary.path)
        if FileManager.default.fileExists(atPath: destination.path) {
            try FileManager.default.removeItem(at: destination)
        }
        try FileManager.default.moveItem(at: temporary, to: destination)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: destination.path)
    }

    private static func stateRootReplacing(clientRoot: URL, profile: String, fallback: String) -> String {
        let url = clientRoot
            .appendingPathComponent("cursor-acp-state", isDirectory: true)
            .appendingPathComponent(profile, isDirectory: true)
        if let created = try? directory(url) { return created }
        return fallback
    }

    private static func directory(_ url: URL) throws -> String {
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        let resolved = url.resolvingSymlinksInPath()
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: resolved.path)
        return resolved.path
    }
}
