import CryptoKit
import Foundation
import TriangleMailboxCore

/// Workload access tokens shared between helper processes. Every helper run is a
/// new process, so without a shared cache each `transaction-*` run and `mcp`
/// session pays a `token-challenges` + `tokens` exchange for a token that lives
/// about five minutes. These cases pin the reuse, the places it must stop, and
/// the fail-safe: a missing, corrupt or unsafe cache behaves as no cache.
public enum WorkloadTokenCacheContractCases {
    public struct ContractCase: Sendable {
        public let name: String
        public let run: @Sendable () async throws -> Void
    }

    public static let all: [ContractCase] = [
        .init(name: "token cache: a second helper process reuses a fresh token", run: sharesTokenAcrossProcesses),
        .init(name: "token cache: reuse stops 30 seconds before expiry and past the lifetime bound", run: refreshesNearExpiry),
        .init(name: "token cache: a refused token is dropped on any 401", run: dropsRefusedToken),
        .init(name: "token cache: a corrupt entry is a miss and is repaired", run: corruptCacheIsAMiss),
        .init(name: "token cache: unsafe storage is ignored", run: unsafeCacheIsIgnored),
        .init(name: "token cache: custody is owner-private and the token is never printed", run: custodyAndRedaction),
        .init(name: "token cache: an entry is bound to its key, origin and scopes", run: entryIsBoundToItsKey),
        .init(name: "token cache: expired entries are pruned", run: prunesExpiredEntries),
        .init(name: "token cache: idle claim-next requests per helper run and per hour", run: idleClaimNextAccounting),
    ]

    // MARK: Cases

    public static func sharesTokenAcrossProcesses() async throws {
        let home = try V1TestCustody.temporaryHome()
        defer { try? FileManager.default.removeItem(at: home) }
        let agent = try V1TestCustody.memoryAgent(profile: "ghost", handle: "ghost-one", fill: "a")
        let mesh = FakeV1Mesh(agents: [agent])
        let cache = FileWorkloadTokenCache(root: home.appendingPathComponent("workload-token"))

        // Process 1 exchanges. Process 2 starts with no in-memory token at all.
        let first = try manager(agent, mesh, cache)
        _ = try await MeshClient(transport: mesh).agentSelf(origin: agent.material.origin, auth: first)
        let second = try manager(agent, mesh, cache)
        _ = try await MeshClient(transport: mesh).agentSelf(origin: agent.material.origin, auth: second)

        try expect(mesh.requestCount(path: "/api/v1/identity/token-challenges") == 1, "second process asked for another challenge")
        try expect(mesh.requestCount(path: "/api/v1/identity/tokens") == 1, "second process exchanged another token")
        let me = mesh.requests.filter { $0.url.path == "/api/v1/agents/me" }
        try expect(me.count == 2, "agents/me not called once per process")
        try expect(me[0].headers["Authorization"] == me[1].headers["Authorization"], "second process used another bearer token")
        try expect(me[0].headers["Authorization"]?.hasPrefix("Bearer at_test_") == true, "no bearer token sent")
        // The token is shared; the proof of possession is not: a DPoP proof is minted per request.
        try expect(me[0].headers["DPoP"] != nil && me[0].headers["DPoP"] != me[1].headers["DPoP"], "DPoP proof was reused across requests")
        let proofs = try me.map { try dpopPayload($0.headers["DPoP"]!) }
        try expect(proofs[0]["jti"] as? String != proofs[1]["jti"] as? String, "DPoP jti was reused")
        try expect(proofs[0]["htm"] as? String == "GET" && proofs[0]["htu"] as? String == me[0].url.absoluteString, "DPoP proof not bound to the request")
        try expect(second.activeAccessToken == first.activeAccessToken, "reused token is not the active token")

        // Without a shared cache every process exchanges its own (today's behavior).
        let bare = FakeV1Mesh(agents: [agent])
        for _ in 0..<2 {
            let alone = try manager(agent, bare, nil)
            _ = try await MeshClient(transport: bare).agentSelf(origin: agent.material.origin, auth: alone)
        }
        try expect(bare.requestCount(path: "/api/v1/identity/tokens") == 2, "no-cache baseline stopped exchanging per process")
    }

    public static func refreshesNearExpiry() async throws {
        let home = try V1TestCustody.temporaryHome()
        defer { try? FileManager.default.removeItem(at: home) }
        let agent = try V1TestCustody.memoryAgent(profile: "ghost", handle: "ghost-one", fill: "a")
        let mesh = FakeV1Mesh(agents: [agent])
        let clock = VirtualClock(1_800_000_000)
        let cache = FileWorkloadTokenCache(root: home.appendingPathComponent("workload-token"))

        _ = try await token(manager(agent, mesh, cache, clock))
        try expect(mesh.requestCount(path: "/api/v1/identity/tokens") == 1, "first process did not exchange")

        // expires_in 300 and a 30 s margin: reusable until 270 s after issue.
        clock.set(1_800_000_000 + 269)
        _ = try await token(manager(agent, mesh, cache, clock))
        try expect(mesh.requestCount(path: "/api/v1/identity/tokens") == 1, "token with 31 s left was exchanged again")
        clock.set(1_800_000_000 + 271)
        _ = try await token(manager(agent, mesh, cache, clock))
        try expect(mesh.requestCount(path: "/api/v1/identity/tokens") == 2, "token with 29 s left was reused")

        // An already-expired entry is dropped when it is read.
        clock.set(1_800_000_000 + 271 + 400)
        let key = try cacheKey(agent)
        try expect(cache.load(for: key, now: clock.now) == nil, "expired entry was served")
        try expect(tokenFiles(home).isEmpty, "expired entry stayed on disk")

        // A lifetime beyond the bound is never written, so it can never be reused.
        let long = FakeV1Mesh(agents: [agent]); long.tokenLifetime = 86_400
        let longHome = home.appendingPathComponent("long")
        let longCache = FileWorkloadTokenCache(root: longHome)
        for _ in 0..<2 { _ = try await token(manager(agent, long, longCache, clock)) }
        try expect(long.requestCount(path: "/api/v1/identity/tokens") == 2, "a 24 h token was shared")
        try expect(tokenFiles(longHome).isEmpty, "a 24 h token was written to disk")
        // Nor one that is about to expire.
        let short = FakeV1Mesh(agents: [agent]); short.tokenLifetime = 20
        let shortHome = home.appendingPathComponent("short")
        _ = try await token(manager(agent, short, FileWorkloadTokenCache(root: shortHome), clock))
        try expect(tokenFiles(shortHome).isEmpty, "a 20 s token was written to disk")
    }

    public static func dropsRefusedToken() async throws {
        let home = try V1TestCustody.temporaryHome()
        defer { try? FileManager.default.removeItem(at: home) }
        let agent = try V1TestCustody.memoryAgent(profile: "ghost", handle: "ghost-one", fill: "a")
        let mesh = FakeV1Mesh(agents: [agent])
        let root = home.appendingPathComponent("workload-token")
        let cache = FileWorkloadTokenCache(root: root)
        let resolver = V1TestCustody.resolver([agent])

        // Process 1 caches T1. The server then revokes it.
        let gate1 = VerifiedCredentialGate(resolver: resolver, transport: mesh, tokenCache: cache)
        _ = try await gate1.credential(for: agent.profile)
        let t1 = try cachedToken(home)
        mesh.revokeIssuedTokens()

        // Process 2: the gate's first call is refused (401); it drops T1 and
        // exchanges once more, then succeeds. Nothing is left holding T1.
        let gate2 = VerifiedCredentialGate(resolver: resolver, transport: mesh, tokenCache: cache)
        let credential = try await gate2.credential(for: agent.profile)
        try expect(credential.agentID == agent.agentID, "gate did not recover from a refused cached token")
        try expect(mesh.requestCount(path: "/api/v1/identity/tokens") == 2, "refused token was not re-exchanged exactly once")
        let t2 = try cachedToken(home)
        try expect(t2 != t1, "refused token is still cached")
        try expect(try credential.workloadAuth(transport: mesh).activeAccessToken == t2, "process does not hold the replacement")

        // Any call site: a 401 to a request that carried the cached token drops it.
        let auth = try credential.workloadAuth(transport: mesh)
        let observed = auth.observingRefusals(of: mesh)
        let meURL = URL(string: agent.material.origin.value + "/api/v1/agents/me")!
        let meHeaders = try await auth.authorizationHeaders(method: "GET", url: meURL)
        // A refusal of some other token does not touch this one.
        let otherHeaders = ["Authorization": "Bearer at_test_someone_elses_token_value", "DPoP": meHeaders["DPoP"]!]
        let otherResponse = try await observed.send(MeshHTTPRequest(method: "GET", url: meURL, headers: otherHeaders))
        try expect(otherResponse.statusCode == 401, "fixture: unknown token was accepted")
        try expect(try cachedToken(home) == t2 && auth.activeAccessToken == t2, "a 401 for another token dropped this one")
        mesh.revokeIssuedTokens()
        let meResponse = try await observed.send(MeshHTTPRequest(method: "GET", url: meURL, headers: meHeaders))
        try expect(meResponse.statusCode == 401, "revoked token was accepted")
        try expect(tokenFiles(home).isEmpty, "a 401 left the refused token on disk")
        try expect(auth.activeAccessToken == nil, "a 401 left the refused token in memory")

        // A 401 for an old token must not delete a newer one another process stored.
        let gate3 = VerifiedCredentialGate(resolver: resolver, transport: mesh, tokenCache: cache)
        _ = try await gate3.credential(for: agent.profile)
        let t3 = try cachedToken(home)
        let straggler = try manager(agent, mesh, cache)
        straggler.invalidate(t2)
        try expect(try cachedToken(home) == t3, "a stale token's invalidation removed the newer entry")
    }

    public static func corruptCacheIsAMiss() async throws {
        let home = try V1TestCustody.temporaryHome()
        defer { try? FileManager.default.removeItem(at: home) }
        let agent = try V1TestCustody.memoryAgent(profile: "ghost", handle: "ghost-one", fill: "a")
        let mesh = FakeV1Mesh(agents: [agent])
        let root = home.appendingPathComponent("workload-token")
        let cache = FileWorkloadTokenCache(root: root)
        let clock = VirtualClock(1_800_000_000)

        _ = try await token(manager(agent, mesh, cache, clock))
        let file = tokenFiles(root).first!
        let good = try Data(contentsOf: file)
        let object = try JSONSerialization.jsonObject(with: good) as! [String: Any]

        func variant(_ change: (inout [String: Any]) -> Void) throws -> Data {
            var copy = object
            change(&copy)
            return try JSONSerialization.data(withJSONObject: copy, options: [.sortedKeys])
        }
        let now = clock.now
        let variants: [(String, Data)] = [
            ("not json", Data("this is not json".utf8)),
            ("truncated", good.prefix(good.count / 2)),
            ("json array", Data("[]".utf8)),
            ("wrong version", try variant { $0["version"] = 2 }),
            ("version as bool", try variant { $0["version"] = true }),
            ("extra key", try variant { $0["note"] = "x" }),
            ("missing key", try variant { $0.removeValue(forKey: "expiresAt") }),
            ("token with newline", try variant { $0["accessToken"] = "at_test_0123456789\nInjected: header" }),
            ("token with space", try variant { $0["accessToken"] = "at_test_0123456789 extra" }),
            ("token too short", try variant { $0["accessToken"] = "short" }),
            ("token not a string", try variant { $0["accessToken"] = 12345 }),
            ("expired", try variant { $0["issuedAt"] = now - 400; $0["expiresAt"] = now - 100 }),
            ("issued in the future", try variant { $0["issuedAt"] = now + 7200; $0["expiresAt"] = now + 7500 }),
            ("lifetime beyond the bound", try variant { $0["issuedAt"] = now; $0["expiresAt"] = now + 4 * 3600 }),
            ("expiry before issue", try variant { $0["issuedAt"] = now; $0["expiresAt"] = now - 5 }),
            ("another workload", try variant { $0["workloadId"] = "workload_" + V1TestCustody.hex("f") }),
            ("another origin", try variant { $0["origin"] = "https://other.example" }),
            ("another key", try variant { $0["keyThumbprint"] = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }),
            ("other scopes", try variant { $0["scopes"] = ["agent.read"] }),
            ("empty file", Data()),
            ("oversized file", Data(repeating: 0x20, count: 64 * 1024)),
        ]
        var exchanges = mesh.requestCount(path: "/api/v1/identity/tokens")
        for (name, data) in variants {
            try V1TestCustody.writePrivate(file, data)
            let fresh = try manager(agent, mesh, cache, clock)
            let issued = try await token(fresh)
            exchanges += 1
            try expect(mesh.requestCount(path: "/api/v1/identity/tokens") == exchanges, "\(name): cache was trusted")
            // The miss repaired the entry, so the next process reuses it.
            try expect(tokenFiles(root).count == 1, "\(name): repair left \(tokenFiles(root).count) files")
            let reused = try await token(manager(agent, mesh, cache, clock))
            try expect(reused == issued, "\(name): the repaired entry was not reused")
            try expect(mesh.requestCount(path: "/api/v1/identity/tokens") == exchanges, "\(name): repaired entry caused another exchange")
        }
    }

    public static func unsafeCacheIsIgnored() async throws {
        let agent = try V1TestCustody.memoryAgent(profile: "ghost", handle: "ghost-one", fill: "a")
        let clock = VirtualClock(1_800_000_000)

        /// Run two processes against `cache`; returns how many tokens were exchanged.
        func exchanges(_ cache: FileWorkloadTokenCache) async throws -> Int {
            let mesh = FakeV1Mesh(agents: [agent])
            for _ in 0..<2 { _ = try await token(manager(agent, mesh, cache, clock)) }
            return mesh.requestCount(path: "/api/v1/identity/tokens")
        }

        // Directory open to group/other: ignored, not written to, not chmod'ed.
        do {
            let home = try V1TestCustody.temporaryHome()
            defer { try? FileManager.default.removeItem(at: home) }
            let root = home.appendingPathComponent("workload-token", isDirectory: true)
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o755])
            let exchanged1 = try await exchanges(FileWorkloadTokenCache(root: root))
            try expect(exchanged1 == 2, "group-readable directory was used")
            try expect(tokenFiles(root).isEmpty, "a token was written into an open directory")
            try expect(mode(root) == 0o755, "an unsafe directory was modified")
        }
        // Directory that is a symlink to a private directory.
        do {
            let home = try V1TestCustody.temporaryHome()
            defer { try? FileManager.default.removeItem(at: home) }
            let real = home.appendingPathComponent("real", isDirectory: true)
            try FileManager.default.createDirectory(at: real, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
            let link = home.appendingPathComponent("workload-token")
            try FileManager.default.createSymbolicLink(at: link, withDestinationURL: real)
            let exchanged2 = try await exchanges(FileWorkloadTokenCache(root: link))
            try expect(exchanged2 == 2, "symlinked directory was used")
            try expect(tokenFiles(real).isEmpty, "a token was written through a symlinked directory")
        }
        // A regular file where the directory should be.
        do {
            let home = try V1TestCustody.temporaryHome()
            defer { try? FileManager.default.removeItem(at: home) }
            let root = home.appendingPathComponent("workload-token")
            try V1TestCustody.writePrivate(root, Data("not a directory".utf8))
            let exchanged3 = try await exchanges(FileWorkloadTokenCache(root: root))
            try expect(exchanged3 == 2, "a file in place of the directory was used")
        }
        // Everything belongs to someone else (the owner check, without needing root).
        do {
            let home = try V1TestCustody.temporaryHome()
            defer { try? FileManager.default.removeItem(at: home) }
            let root = home.appendingPathComponent("workload-token")
            let mine = FileWorkloadTokenCache(root: root)
            let exchanged4 = try await exchanges(mine)
            try expect(exchanged4 == 1, "fixture cache did not share")
            let foreign = FileWorkloadTokenCache(root: root, owner: getuid() &+ 1)
            let exchanged5 = try await exchanges(foreign)
            try expect(exchanged5 == 2, "entries owned by another user were used")
        }
        // An entry file open to group/other, or with a second hard link, is not trusted.
        func damaged(_ name: String, _ damage: (URL, URL) throws -> Void) async throws {
            let home = try V1TestCustody.temporaryHome()
            defer { try? FileManager.default.removeItem(at: home) }
            let root = home.appendingPathComponent("workload-token")
            let cache = FileWorkloadTokenCache(root: root)
            let mesh = FakeV1Mesh(agents: [agent])
            _ = try await token(manager(agent, mesh, cache, clock))
            try damage(tokenFiles(root)[0], home)
            _ = try await token(manager(agent, mesh, cache, clock))
            try expect(mesh.requestCount(path: "/api/v1/identity/tokens") == 2, "\(name) was trusted")
        }
        try await damaged("group-readable file") { file, _ in
            try FileManager.default.setAttributes([.posixPermissions: 0o640], ofItemAtPath: file.path)
        }
        try await damaged("world-readable file") { file, _ in
            try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: file.path)
        }
        try await damaged("hard-linked file") { file, home in
            try FileManager.default.linkItem(at: file, to: home.appendingPathComponent("second-link"))
        }
        // A symlinked entry is not followed, and is replaced rather than written through.
        do {
            let home = try V1TestCustody.temporaryHome()
            defer { try? FileManager.default.removeItem(at: home) }
            let root = home.appendingPathComponent("workload-token")
            let cache = FileWorkloadTokenCache(root: root)
            let mesh = FakeV1Mesh(agents: [agent])
            _ = try await token(manager(agent, mesh, cache, clock))
            let file = tokenFiles(root).first!
            let elsewhere = home.appendingPathComponent("elsewhere.json")
            try FileManager.default.moveItem(at: file, to: elsewhere)
            try FileManager.default.createSymbolicLink(at: file, withDestinationURL: elsewhere)
            let before = try Data(contentsOf: elsewhere)
            let issued = try await token(manager(agent, mesh, cache, clock))
            try expect(mesh.requestCount(path: "/api/v1/identity/tokens") == 2, "symlinked entry was trusted")
            // The write replaced the link itself and never followed it.
            try expect(try Data(contentsOf: elsewhere) == before, "a symlink target was overwritten")
            try expect(try cachedToken(home) == issued, "the symlink was not replaced by a regular entry")
        }
    }

    public static func custodyAndRedaction() async throws {
        let home = try V1TestCustody.temporaryHome()
        defer { try? FileManager.default.removeItem(at: home) }
        let agent = try V1TestCustody.memoryAgent(profile: "ghost", handle: "ghost-one", fill: "a")
        let mesh = FakeV1Mesh(agents: [agent])
        // Not created in advance: the cache creates its own private directory chain.
        let root = home.appendingPathComponent("credentials/local/workload-token", isDirectory: true)
        let cache = FileWorkloadTokenCache(root: root)
        let gate = VerifiedCredentialGate(resolver: V1TestCustody.resolver([agent]), transport: mesh, tokenCache: cache)
        let credential = try await gate.credential(for: agent.profile)
        let auth = try credential.workloadAuth(transport: mesh)
        let token = try cachedToken(home)

        try expect(mode(root) == 0o700, "cache directory is not 0700")
        let files = tokenFiles(root)
        try expect(files.count == 1, "expected one entry, found \(files.count)")
        try expect(mode(files[0]) == 0o600, "cache file is not 0600")
        try expect(!files[0].lastPathComponent.contains(agent.workloadID.value), "file name exposes the workload id")
        try expect(!files[0].lastPathComponent.contains("thetriangle"), "file name exposes the origin")
        let leftovers = try FileManager.default.contentsOfDirectory(atPath: root.path).filter { $0.hasPrefix(".tmp-") }
        try expect(leftovers.isEmpty, "temporary files were left behind")
        let content = try String(contentsOf: files[0], encoding: .utf8)
        try expect(!content.contains(agent.seed), "the workload private key reached the cache")
        // The private key, a proof, or anything but the token and its metadata stays out.
        let object = try JSONSerialization.jsonObject(with: Data(content.utf8)) as! [String: Any]
        try expect(Set(object.keys) == ["version", "origin", "workloadId", "keyThumbprint", "scopes", "accessToken", "issuedAt", "expiresAt"], "unexpected cache fields")

        // The token is never part of a description, a reflection or an error.
        let cached = CachedWorkloadToken(accessToken: token, issuedAt: 1, expiresAt: 2)
        var dumped = ""
        dump(cached, to: &dumped)
        var dumpedAuth = ""
        dump(auth, to: &dumpedAuth)
        var dumpedCredential = ""
        dump(credential, to: &dumpedCredential)
        let outputs = [
            String(describing: cached), String(reflecting: cached), dumped,
            String(describing: auth), String(reflecting: auth), dumpedAuth,
            String(describing: credential), dumpedCredential,
            "\(cached)", "\(auth)",
        ]
        for output in outputs {
            try expect(!output.contains(token), "a diagnostic exposed the access token")
            try expect(!output.contains(agent.seed), "a diagnostic exposed the workload key")
        }
        let meURL = URL(string: "https://thetriangle.dev/api/v1/agents/me")!
        let request = MeshHTTPRequest(method: "GET", url: meURL, headers: try await auth.authorizationHeaders(method: "GET", url: meURL))
        try expect(!String(describing: request).contains(token) && !String(reflecting: request).contains(token), "a request description exposed the token")
    }

    public static func entryIsBoundToItsKey() async throws {
        let home = try V1TestCustody.temporaryHome()
        defer { try? FileManager.default.removeItem(at: home) }
        let ghost = try V1TestCustody.memoryAgent(profile: "ghost", handle: "ghost-one", fill: "a")
        let bob = try V1TestCustody.memoryAgent(profile: "bob", handle: "bob-one", fill: "b")
        let readOnly = try V1TestCustody.memoryAgent(profile: "ghost-ro", handle: "ghost-ro", fill: "a", scopes: ["agent.read"])
        let preview = try V1TestCustody.memoryAgent(profile: "ghost-preview", handle: "ghost-pre", fill: "a", origin: "https://preview.thetriangle.dev")
        let mesh = FakeV1Mesh(agents: [ghost, bob, readOnly, preview])
        let cache = FileWorkloadTokenCache(root: home.appendingPathComponent("workload-token"))

        // Four different (origin, workload, key, scopes) tuples; none may serve another.
        var tokens: [String] = []
        for agent in [ghost, bob, readOnly, preview] {
            tokens.append(try await token(manager(agent, mesh, cache), origin: agent.material.origin.value))
        }
        try expect(Set(tokens).count == 4, "tuples shared a token")
        try expect(tokenFiles(home).count == 4, "expected one entry per tuple")
        for (index, agent) in [ghost, bob, readOnly, preview].enumerated() {
            let again = try await token(manager(agent, mesh, cache), origin: agent.material.origin.value)
            try expect(again == tokens[index], "entry \(index) was not reused by its own tuple")
        }
        try expect(mesh.requestCount(path: "/api/v1/identity/tokens") == 4, "a tuple exchanged twice")

        // The same workload id with a rotated key (new thumbprint) misses.
        let rotatedKey = V1AgentMaterial(
            agentID: ghost.agentID, handle: ghost.handle, workloadID: ghost.workloadID,
            privateKey: Curve25519.Signing.PrivateKey(), scopes: ghost.material.scopes,
            authority: ghost.material.authority, origin: ghost.material.origin, keyFile: ghost.keyFile
        )
        let rotatedMesh = FakeV1Mesh(agents: [V1TestAgent(profile: ghost.profile, material: rotatedKey)])
        let rotated = try WorkloadTokenManager(origin: rotatedKey.origin, workloadRecord: rotatedKey.workloadRecord, transport: rotatedMesh, tokenCache: cache)
        let rotatedToken = try await token(rotated)
        try expect(rotatedMesh.requestCount(path: "/api/v1/identity/tokens") == 1, "a token for the old key served the rotated key")
        try expect(!tokens.contains(rotatedToken), "rotated key received the old key's token")
    }

    public static func prunesExpiredEntries() async throws {
        let home = try V1TestCustody.temporaryHome()
        defer { try? FileManager.default.removeItem(at: home) }
        let ghost = try V1TestCustody.memoryAgent(profile: "ghost", handle: "ghost-one", fill: "a")
        let bob = try V1TestCustody.memoryAgent(profile: "bob", handle: "bob-one", fill: "b")
        let mesh = FakeV1Mesh(agents: [ghost, bob])
        let root = home.appendingPathComponent("workload-token")
        let cache = FileWorkloadTokenCache(root: root)
        let clock = VirtualClock(1_800_000_000)

        _ = try await token(manager(ghost, mesh, cache, clock))
        try expect(tokenFiles(root).count == 1, "fixture entry missing")
        // bob's entry is stored after ghost's has expired; ghost is never asked for again.
        clock.set(1_800_000_000 + 600)
        _ = try await token(manager(bob, mesh, cache, clock))
        let remaining = tokenFiles(root)
        try expect(remaining.count == 1, "expired entry of another key stayed on disk (\(remaining.count) files)")
        let live = try cachedToken(home)
        let reused = try await token(manager(bob, mesh, cache, clock))
        try expect(reused == live, "the live entry was pruned")
    }

    public static func idleClaimNextAccounting() async throws {
        let home = try V1TestCustody.temporaryHome()
        defer { try? FileManager.default.removeItem(at: home) }
        let agent = try V1TestCustody.memoryAgent(profile: "ghost", handle: "ghost-one", fill: "a")
        let clock = VirtualClock(1_800_000_000)

        // One helper process: what `triangle-mailbox transaction-claim-next` does
        // against an empty mailbox. The token is exchanged only when none is shared.
        func run(_ mesh: CountingMailboxMesh, _ cache: (any WorkloadTokenCache)?) async throws {
            let gate = VerifiedCredentialGate(resolver: V1TestCustody.resolver([agent]), transport: mesh, tokenCache: cache, clock: { clock.now })
            let credential = try await gate.credential(for: agent.profile)
            let auth = try credential.workloadAuth(transport: mesh)
            let transport = AuthenticatedMailboxTransactionTransport(
                origin: credential.origin, transport: auth.observingRefusals(of: mesh), actorID: credential.agentID
            ) { method, url in try await auth.authorizationHeaders(method: method, url: url) }
            let service = MailboxTransactionService(store: InMemoryMailboxTransactionStore(), transport: transport)
            let status = try await service.claimNext(instanceID: .derive(profile: agent.profile), protocolOwnership: .selfServeDrain)
            try expect(status["open"] is NSNull && status["shouldStartModel"] as? Bool == false, "idle claim-next found work")
        }

        // Per run: an empty mailbox costs the identity gate plus one list.
        do {
            let mesh = CountingMailboxMesh(agents: [agent])
            try await run(mesh, nil)
            try expect(mesh.counts == [
                "POST /api/v1/identity/token-challenges": 1, "POST /api/v1/identity/tokens": 1,
                "GET /api/v1/agents/me": 1, "GET /api/v1/mailbox": 1,
            ], "per-run requests without a shared token: \(mesh.counts)")
        }
        do {
            let mesh = CountingMailboxMesh(agents: [agent])
            let cache = FileWorkloadTokenCache(root: home.appendingPathComponent("runs"))
            try await run(mesh, cache)
            try await run(mesh, cache)
            try expect(mesh.counts == [
                "POST /api/v1/identity/token-challenges": 1, "POST /api/v1/identity/tokens": 1,
                "GET /api/v1/agents/me": 2, "GET /api/v1/mailbox": 2,
            ], "per-run requests with a shared token: \(mesh.counts)")
        }

        // One hour of the idle Cursor lane before wake-driven claiming: a run about
        // every 35 s (30 s poll + the run itself), 103 runs, tokens of 300 s reused
        // until 30 s before expiry.
        func hour(spacing: Int, runs: Int, _ cache: (any WorkloadTokenCache)?) async throws -> CountingMailboxMesh {
            let mesh = CountingMailboxMesh(agents: [agent])
            for index in 0..<runs {
                clock.set(1_800_000_000 + TimeInterval(index * spacing))
                try await run(mesh, cache)
            }
            return mesh
        }
        let runs = 103
        let before = try await hour(spacing: 35, runs: runs, nil)
        let after = try await hour(spacing: 35, runs: runs, FileWorkloadTokenCache(root: home.appendingPathComponent("hour")))
        try expect(before.total == runs * 4, "without a shared token an hour is \(before.total) requests, expected \(runs * 4)")
        // 13 exchanges (every 8th run) at 2 requests, plus gate + list per run.
        try expect(after.counts["POST /api/v1/identity/tokens"] == 13, "tokens exchanged per hour: \(after.counts)")
        try expect(after.total == runs * 2 + 13 * 2, "with a shared token an hour is \(after.total) requests, expected \(runs * 2 + 13 * 2)")

        // At the wake-driven safety cadence (a run about every 330 s) a 300 s token has
        // always expired before the next run, so every safety run exchanges its own: the
        // shared token saves nothing for an idle lane there. That saving comes from
        // fewer runs; the shared token pays off for bursts (claim, reply, ack, MCP sessions).
        let safetyRuns = 11
        let safetyBare = try await hour(spacing: 330, runs: safetyRuns, nil)
        let safetyShared = try await hour(spacing: 330, runs: safetyRuns, FileWorkloadTokenCache(root: home.appendingPathComponent("safety")))
        try expect(safetyBare.total == safetyRuns * 4 && safetyShared.total == safetyRuns * 4, "safety-cadence hour: \(safetyBare.total) / \(safetyShared.total)")
    }

    // MARK: Fixtures

    /// The bearer token a manager would send now: exchanged or taken from the shared
    /// cache exactly as a real request would (public API only).
    private static func token(_ manager: WorkloadTokenManager, origin: String = "https://thetriangle.dev") async throws -> String {
        let url = URL(string: origin + "/api/v1/agents/me")!
        let headers = try await manager.authorizationHeaders(method: "GET", url: url)
        guard let authorization = headers["Authorization"], authorization.hasPrefix("Bearer ") else {
            throw ContractFailure("no bearer token")
        }
        return String(authorization.dropFirst("Bearer ".count))
    }

    private static func manager(
        _ agent: V1TestAgent, _ mesh: any MeshTransport, _ cache: (any WorkloadTokenCache)?, _ clock: VirtualClock? = nil
    ) throws -> WorkloadTokenManager {
        if let clock {
            return try WorkloadTokenManager(
                origin: agent.material.origin, workloadRecord: agent.material.workloadRecord, transport: mesh,
                tokenCache: cache, clock: { clock.now }
            )
        }
        return try WorkloadTokenManager(
            origin: agent.material.origin, workloadRecord: agent.material.workloadRecord, transport: mesh, tokenCache: cache
        )
    }

    private static func cacheKey(_ agent: V1TestAgent) throws -> WorkloadTokenCacheKey {
        WorkloadTokenCacheKey(
            origin: agent.material.origin, workloadID: agent.workloadID,
            keyThumbprint: WorkloadPublicJWK(publicKey: agent.material.privateKey.publicKey).jkt, scopes: agent.material.scopes
        )
    }

    /// Every `token-*.json` below `directory` (symlinked directories are not followed).
    private static func tokenFiles(_ directory: URL) -> [URL] {
        guard let walker = FileManager.default.enumerator(atPath: directory.path) else { return [] }
        var found: [URL] = []
        for case let relative as String in walker {
            let name = (relative as NSString).lastPathComponent
            if name.hasPrefix("token-"), name.hasSuffix(".json") { found.append(directory.appendingPathComponent(relative)) }
        }
        return found.sorted { $0.path < $1.path }
    }

    /// The token held by the first cache entry under `directory`.
    private static func cachedToken(_ directory: URL) throws -> String {
        guard let file = tokenFiles(directory).first else { throw ContractFailure("no cache entry under \(directory.lastPathComponent)") }
        let object = try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any]
        guard let token = object?["accessToken"] as? String else { throw ContractFailure("cache entry has no token") }
        return token
    }

    private static func mode(_ url: URL) -> Int {
        ((try? FileManager.default.attributesOfItem(atPath: url.path)[.posixPermissions]) as? NSNumber)?.intValue ?? -1
    }

    private static func dpopPayload(_ proof: String) throws -> [String: Any] {
        let parts = proof.split(separator: ".").map(String.init)
        guard parts.count == 3, let data = Base64URL.decode(parts[1]),
              let object = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { throw ContractFailure("malformed DPoP proof") }
        return object
    }

    private static func expect(_ condition: @autoclosure () throws -> Bool, _ message: String) throws {
        guard try condition() else { throw ContractFailure(message) }
    }
}

/// A clock the test moves by hand (seconds since the epoch).
final class VirtualClock: @unchecked Sendable {
    private let lock = NSLock()
    private var value: TimeInterval
    init(_ start: TimeInterval) { value = start }
    var now: TimeInterval { lock.withLock { value } }
    func set(_ next: TimeInterval) { lock.withLock { value = next } }
}

/// The fake identity plane plus an authenticated, empty `GET /api/v1/mailbox`,
/// counting every request by method and path (what one hour of helper runs costs
/// MESH, seen from the helper).
final class CountingMailboxMesh: MeshTransport, @unchecked Sendable {
    private let inner: FakeV1Mesh
    private let lock = NSLock()
    private var tally: [String: Int] = [:]

    init(agents: [V1TestAgent]) { inner = FakeV1Mesh(agents: agents) }

    var counts: [String: Int] { lock.withLock { tally } }
    var total: Int { lock.withLock { tally.values.reduce(0, +) } }

    func send(_ request: MeshHTTPRequest) async throws -> MeshHTTPResponse {
        lock.withLock { tally["\(request.method) \(request.url.path)", default: 0] += 1 }
        if request.method == "GET", request.url.path == "/api/v1/mailbox" {
            guard inner.workload(forAuthorization: request.headers) != nil else {
                return FakeV1Mesh.json(401, ["error": "agent_auth_required"], request)
            }
            return FakeV1Mesh.json(200, ["items": []], request)
        }
        return try await inner.send(request)
    }
}
