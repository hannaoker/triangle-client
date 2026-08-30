import Foundation
import TriangleMailboxCore

private let optInVariable = "TRIANGLE_RUN_DISPOSABLE_KEYCHAIN_TEST"

guard ProcessInfo.processInfo.environment[optInVariable] == "1" else {
    FileHandle.standardError.write(
        Data("Refusing live Keychain test without explicit environment opt-in.\n".utf8)
    )
    exit(64)
}

do {
    let uniqueHex = UUID().uuidString.lowercased().replacingOccurrences(of: "-", with: "")
    let profile = try ProfileName("integration-\(uniqueHex.prefix(24))")
    let original = try CredentialBinding(
        origin: MeshOrigin("https://thetriangle.dev"),
        agentID: AgentID("agent_\(uniqueHex)"),
        handle: MailboxHandle("integration-\(uniqueHex.prefix(16))"),
        token: MeshToken("mesh_\(String(repeating: "d", count: 64))")
    )
    let replacement = try CredentialBinding(
        origin: MeshOrigin("https://thetriangle.dev"),
        agentID: AgentID("agent_\(uniqueHex)"),
        handle: MailboxHandle("integration-\(uniqueHex.prefix(16))"),
        token: MeshToken("mesh_\(String(repeating: "e", count: 64))")
    )
    let store = KeychainCredentialStore()
    var ownsItem = false

    // Preflight the exact fixed-service/UUID-account selector before creating
    // anything. A collision is a hard stop; this test never replaces it.
    do {
        _ = try store.read(for: profile)
        throw CredentialStoreError.duplicateItem
    } catch CredentialStoreError.itemNotFound {
        // Expected disposable starting state.
    }

    var lifecycleError: Error?
    do {
        try store.create(original, for: profile)
        ownsItem = true
        guard try KeychainCredentialStore().read(for: profile) == original else {
            throw CredentialStoreError.invalidStoredCredential
        }
        try KeychainCredentialStore().replace(replacement, for: profile, confirmation: .confirmed)
        guard try KeychainCredentialStore().read(for: profile) == replacement else {
            throw CredentialStoreError.invalidStoredCredential
        }
    } catch {
        lifecycleError = error
    }

    var cleanupError: Error?
    if ownsItem {
        do {
            try KeychainCredentialStore().delete(for: profile)
            ownsItem = false
        } catch {
            cleanupError = error
        }
    }
    do {
        _ = try KeychainCredentialStore().read(for: profile)
        cleanupError = CredentialStoreError.keychainFailure
    } catch CredentialStoreError.itemNotFound {
        // Exact-item absence is verified after both success and failure paths.
    } catch {
        cleanupError = error
    }
    if cleanupError != nil {
        throw CredentialStoreError.keychainFailure
    }
    if let lifecycleError {
        throw lifecycleError
    }
    print("PASS disposable Keychain lifecycle")
} catch {
    FileHandle.standardError.write(Data("FAIL disposable Keychain lifecycle: \(error)\n".utf8))
    exit(1)
}
