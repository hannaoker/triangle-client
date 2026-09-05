import Testing
import TriangleMailboxTestSupport

@Suite("MESH watch-grant transport")
struct WatchGrantTests {
    @Test("identifiers")
    func identifiers() throws {
        try WatchGrantContractCases.identifiers()
    }

    @Test("binding redacts secrets")
    func bindingRedactsSecrets() throws {
        try WatchGrantContractCases.bindingRedactsSecrets()
    }

    @Test("store lifecycle")
    func storeLifecycle() throws {
        try WatchGrantContractCases.storeLifecycle()
    }

    @Test("errors never include credentials")
    func secretFreeErrors() throws {
        try WatchGrantContractCases.secretFreeErrors()
    }

    @Test("command parser")
    func commandParser() throws {
        try WatchGrantContractCases.commandParser()
    }

    @Test("ensure join finalize stores credential")
    func ensureLifecycle() async throws {
        try await WatchGrantContractCases.ensureLifecycle()
    }

    @Test("status is secret-free")
    func statusSecretFree() async throws {
        try await WatchGrantContractCases.statusSecretFree()
    }

    @Test("poll and resync mapping")
    func pollAndResync() async throws {
        try await WatchGrantContractCases.pollAndResync()
    }

    @Test("revoke clears local binding")
    func revokeClearsBinding() async throws {
        try await WatchGrantContractCases.revokeClearsBinding()
    }

    @Test("excludes mcp-interactive members")
    func excludesInteractive() async throws {
        try await WatchGrantContractCases.excludesInteractive()
    }

    @Test("fails closed without keychain")
    func failsClosedWithoutStore() async throws {
        try await WatchGrantContractCases.failsClosedWithoutStore()
    }

#if canImport(Security)
    @Test("Keychain query policy")
    func keychainQueryPolicy() throws {
        try WatchGrantContractCases.keychainQueryPolicy()
    }
#endif
}
