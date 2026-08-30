import Foundation
import TriangleMailboxCore

public struct ContractFailure: Error, CustomStringConvertible, Sendable {
    public let description: String

    init(_ description: String) {
        self.description = description
    }
}

public enum ModelContractCases {
    public struct ContractCase: Sendable {
        public let name: String
        public let run: @Sendable () throws -> Void
    }

    public static let all: [ContractCase] = [
        .init(name: "profile names", run: profileNames),
        .init(name: "MESH origins", run: meshOrigins),
        .init(name: "loopback HTTP", run: loopbackHTTP),
        .init(name: "identifiers", run: identifiers),
        .init(name: "mailbox handles", run: mailboxHandles),
        .init(name: "credential binding schema", run: strictCredentialBinding),
        .init(name: "credential diagnostics", run: credentialDiagnostics),
        .init(name: "command parser", run: commandParser),
    ]

    public static func profileNames() throws {
        try expect(try ProfileName("codex-mailbox-live").value == "codex-mailbox-live", "valid profile rejected")

        for invalid in ["", "folder/profile", "folder\\profile", "line\nbreak", String(repeating: "a", count: 65)] {
            try expectThrows(ModelValidationError.self, "invalid profile accepted") {
                try ProfileName(invalid)
            }
        }

        let exactly64Bytes = String(repeating: "a", count: 64)
        try expect(try ProfileName(exactly64Bytes).value == exactly64Bytes, "64-byte profile rejected")
        try expectThrows(ModelValidationError.self, "profile byte limit not enforced") {
            try ProfileName(String(repeating: "é", count: 33))
        }
    }

    public static func meshOrigins() throws {
        try expect(try MeshOrigin("https://thetriangle.dev").value == "https://thetriangle.dev", "valid origin rejected")
        try expect(try MeshOrigin("https://thetriangle.dev/").value == "https://thetriangle.dev", "origin was not canonicalized")

        for invalid in [
            "http://thetriangle.dev",
            "https://user:password@thetriangle.dev",
            "https://thetriangle.dev/api/mcp",
            "https://thetriangle.dev?redirect=elsewhere",
            "https://thetriangle.dev#fragment",
        ] {
            try expectThrows(ModelValidationError.self, "non-origin URL accepted") {
                try MeshOrigin(invalid)
            }
        }
    }

    public static func loopbackHTTP() throws {
        try expectThrows(ModelValidationError.self, "loopback HTTP accepted without test allowance") {
            try MeshOrigin("http://127.0.0.1:8080")
        }
        try expect(try MeshOrigin("http://127.0.0.1:8080", allowLoopbackHTTPForTests: true).value == "http://127.0.0.1:8080", "IPv4 loopback rejected")
        try expect(try MeshOrigin("http://localhost:8080", allowLoopbackHTTPForTests: true).value == "http://localhost:8080", "localhost rejected")
        try expect(try MeshOrigin("http://[::1]:8080", allowLoopbackHTTPForTests: true).value == "http://[::1]:8080", "IPv6 loopback rejected")
        try expectThrows(ModelValidationError.self, "private-network HTTP accepted") {
            try MeshOrigin("http://192.168.1.5:8080", allowLoopbackHTTPForTests: true)
        }
    }

    public static func identifiers() throws {
        let agentID = "agent_" + String(repeating: "a", count: 32)
        let token = "mesh_" + String(repeating: "b", count: 64)
        try expect(try AgentID(agentID).value == agentID, "valid agent ID rejected")
        _ = try MeshToken(token)

        for invalid in ["agent_123", "agent_" + String(repeating: "A", count: 32), "room_" + String(repeating: "a", count: 32)] {
            try expectThrows(ModelValidationError.self, "noncanonical agent ID accepted") {
                try AgentID(invalid)
            }
        }
        for invalid in ["mesh_short", "mesh_peer_" + String(repeating: "a", count: 64), "mesh_" + String(repeating: "G", count: 64)] {
            try expectThrows(ModelValidationError.self, "noncanonical permanent token accepted") {
                try MeshToken(invalid)
            }
        }
    }

    public static func mailboxHandles() throws {
        for valid in ["abc", "codex-mailbox-live", "a1b", "a-b-c"] {
            try expect(try MailboxHandle(valid).value == valid, "valid mailbox handle rejected")
        }
        for invalid in [
            "ab",
            "Codex",
            "1codex",
            "codex--live",
            "codex-",
            "codex_live",
            "codex\nlive",
            String(repeating: "a", count: 33),
        ] {
            try expectThrows(ModelValidationError.self, "invalid mailbox handle accepted") {
                try MailboxHandle(invalid)
            }
        }
    }

    public static func strictCredentialBinding() throws {
        let binding = try JSONDecoder().decode(CredentialBinding.self, from: Data(bindingJSON().utf8))
        try expect(binding.version == 1, "binding version changed")
        try expect(binding.origin.value == "https://thetriangle.dev", "binding origin changed")
        try expect(binding.handle.value == "codex-mailbox-live", "binding handle changed")

        try expectThrows(DecodingError.self, "unsupported binding version accepted") {
            try JSONDecoder().decode(CredentialBinding.self, from: Data(bindingJSON(version: 2).utf8))
        }
        try expectThrows(DecodingError.self, "unknown binding key accepted") {
            try JSONDecoder().decode(CredentialBinding.self, from: Data(bindingJSON(extra: ",\"unexpected\":true").utf8))
        }
        for invalidHandle in ["ab", "Codex", "codex--live", "codex-", "codex\nlive", String(repeating: "a", count: 33)] {
            try expectThrows(DecodingError.self, "malformed binding handle accepted") {
                try JSONDecoder().decode(
                    CredentialBinding.self,
                    from: Data(bindingJSON(handle: invalidHandle).utf8)
                )
            }
        }
    }

    public static func credentialDiagnostics() throws {
        let canary = "mesh_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
        let token = try MeshToken(canary)
        let binding = try JSONDecoder().decode(
            CredentialBinding.self,
            from: Data(bindingJSON(token: canary).utf8)
        )

        var tokenDump = ""
        dump(token, to: &tokenDump)
        var bindingDump = ""
        dump(binding, to: &bindingDump)
        let outputs = [
            String(describing: token),
            String(reflecting: token),
            tokenDump,
            String(describing: binding),
            String(reflecting: binding),
            bindingDump,
            String(describing: Mirror(reflecting: token).children.map { $0.value }),
            String(describing: Mirror(reflecting: binding).children.map { $0.value }),
        ]
        for output in outputs {
            try expect(!output.contains(canary), "credential diagnostic exposed permanent token")
        }
    }

    public static func commandParser() throws {
        try expect(try CommandParser.parse(["enroll", "--profile", "mailbox", "--origin", "https://thetriangle.dev"]).command == .enroll, "enroll rejected")
        try expect(try CommandParser.parse(["status", "--profile", "mailbox"]).command == .status, "status rejected")
        try expect(try CommandParser.parse(["mcp", "--profile", "mailbox"]).command == .mcp, "mcp rejected")
        let codexWorker = try CommandParser.parse(["run-worker", "--profile", "mailbox", "--worker", "codex"])
        try expect(codexWorker.command == .runWorker, "run-worker rejected")
        try expect(codexWorker.worker == .codex, "codex worker selector changed")
        let hermesWorker = try CommandParser.parse(["run-worker", "--profile", "mailbox", "--worker", "hermes"])
        try expect(hermesWorker.worker == .hermes, "hermes worker selector changed")
        let supervisor = try CommandParser.parse(["run-supervisor"])
        try expect(supervisor.command == .runSupervisor, "run-supervisor rejected")
        try expect(supervisor.profile == nil && supervisor.origin == nil && supervisor.worker == nil, "run-supervisor accepted a selector")
        let preflight = try CommandParser.parse(["preflight-supervisor"])
        try expect(preflight.command == .preflightSupervisor, "preflight-supervisor rejected")
        try expect(preflight.profile == nil && preflight.origin == nil && preflight.worker == nil, "preflight-supervisor accepted a selector")

        for invalid in [
            ["show-token", "--profile", "mailbox"],
            ["export", "--profile", "mailbox"],
            ["status", "--profile", "mailbox", "--verbose"],
            ["enroll", "--profile", "mailbox", "--origin", "https://thetriangle.dev", "--token", "secret"],
            ["run-worker", "--profile", "mailbox", "--worker", "codex", "--", "/usr/bin/env"],
            ["run-worker", "--profile", "mailbox", "--worker", "/usr/bin/env"],
            ["run-worker", "--profile", "mailbox", "--worker", "other"],
            ["run-worker", "--profile", "mailbox", "--worker", "codex", "--extra", "value"],
            ["run-supervisor", "--profile", "mailbox"],
            ["run-supervisor", "--token", "secret"],
            ["run-supervisor", "anything"],
            ["preflight-supervisor", "--profile", "mailbox"],
            ["preflight-supervisor", "--token", "secret"],
            ["preflight-supervisor", "anything"],
        ] {
            try expectThrows(CommandParseError.self, "closed command surface accepted invalid input") {
                try CommandParser.parse(invalid)
            }
        }
    }

    private static func expect(_ condition: @autoclosure () throws -> Bool, _ message: String) throws {
        guard try condition() else { throw ContractFailure(message) }
    }

    private static func expectThrows<T: Error, Result>(
        _ type: T.Type,
        _ message: String,
        operation: () throws -> Result
    ) throws {
        do {
            _ = try operation()
            throw ContractFailure(message)
        } catch is T {
            return
        } catch {
            throw ContractFailure("\(message): wrong error type")
        }
    }

    private static func bindingJSON(
        version: Int = 1,
        handle: String = "codex-mailbox-live",
        token: String = "mesh_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        extra: String = ""
    ) -> String {
        let escapedHandle = handle
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\n", with: "\\n")
            .replacingOccurrences(of: "\"", with: "\\\"")
        return """
        {
          "version": \(version),
          "origin": "https://thetriangle.dev",
          "agentId": "agent_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "handle": "\(escapedHandle)",
          "token": "\(token)"
          \(extra)
        }
        """
    }
}
