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
        try expect(try AgentID(agentID).value == agentID, "valid agent ID rejected")

        for invalid in ["agent_123", "agent_" + String(repeating: "A", count: 32), "room_" + String(repeating: "a", count: 32)] {
            try expectThrows(ModelValidationError.self, "noncanonical agent ID accepted") {
                try AgentID(invalid)
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

    public static func commandParser() throws {
        let keyFile = "/tmp/v1/agents/agent_\(String(repeating: "a", count: 32))/workload-key.json"
        let bind = try CommandParser.parse(["bind", "--profile", "mailbox", "--key-file", keyFile])
        try expect(bind.command == .bind && bind.keyFile == keyFile && bind.origin == nil, "bind rejected")
        let bindOrigin = try CommandParser.parse(["bind", "--profile", "mailbox", "--key-file", keyFile, "--origin", "https://thetriangle.dev"])
        try expect(bindOrigin.origin?.value == "https://thetriangle.dev", "bind --origin rejected")
        try expect(try CommandParser.parse(["unbind", "--profile", "mailbox"]).command == .unbind, "unbind rejected")
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
        let watchEnsure = try CommandParser.parse([
            "watch-ensure", "--installation", "inst_N7VhDq3mQ2", "--actor-profile", "mailbox",
        ])
        try expect(watchEnsure.command == .watchEnsure, "watch-ensure rejected")
        try expect(watchEnsure.installationID?.value == "inst_N7VhDq3mQ2", "watch-ensure installation missing")
        let watchPoll = try CommandParser.parse([
            "watch-poll", "--installation", "inst_N7VhDq3mQ2", "--cursor", "0",
        ])
        try expect(watchPoll.command == .watchPoll && watchPoll.cursor == 0, "watch-poll rejected")
        let txnClaim = try CommandParser.parse([
            "transaction-claim",
            "--profile", "mailbox",
            "--protocol", "coordinator-delivery-v1",
            "--delivery-id", "12",
            "--room-id", "room_" + String(repeating: "a", count: 32),
            "--event-id", "event_" + String(repeating: "b", count: 32),
        ])
        try expect(txnClaim.command == .transactionClaim && txnClaim.deliveryID == 12, "transaction-claim rejected")

        for invalid in [
            ["show-token", "--profile", "mailbox"],
            ["export", "--profile", "mailbox"],
            ["status", "--profile", "mailbox", "--verbose"],
            ["enroll", "--profile", "mailbox", "--origin", "https://thetriangle.dev"],
            ["bind", "--profile", "mailbox"],
            ["bind", "--profile", "mailbox", "--key-file", "relative/workload-key.json"],
            ["bind", "--profile", "mailbox", "--key-file", keyFile, "--token", "secret"],
            ["bind", "--profile", "mailbox", "--key-file", keyFile, "--origin", "http://thetriangle.dev"],
            ["unbind", "--profile", "mailbox", "--key-file", keyFile],
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
            ["watch-ensure", "--installation", "inst_N7VhDq3mQ2", "--token", "secret"],
            ["watch-poll", "--installation", "inst_N7VhDq3mQ2", "--cursor", "-1"],
            ["watch-status", "--installation", "bad"],
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

}
