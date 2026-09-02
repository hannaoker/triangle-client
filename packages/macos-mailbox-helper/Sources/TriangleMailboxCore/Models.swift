import Foundation

public enum ModelValidationError: Error, Equatable, Sendable {
    case invalidProfileName
    case invalidOrigin
    case invalidAgentID
    case invalidMailboxHandle
    case invalidToken
    case invalidPublicJWK
    case invalidWorkloadID
}

public struct ProfileName: RawRepresentable, Codable, Equatable, Hashable, Sendable {
    public let rawValue: String

    public var value: String { rawValue }

    public init(_ value: String) throws {
        guard !value.isEmpty,
              value.utf8.count <= 64,
              !value.contains("/"),
              !value.contains("\\"),
              value.unicodeScalars.allSatisfy({ !CharacterSet.controlCharacters.contains($0) })
        else {
            throw ModelValidationError.invalidProfileName
        }
        rawValue = value
    }

    public init?(rawValue: String) {
        guard let value = try? ProfileName(rawValue) else { return nil }
        self = value
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        let decoded = try container.decode(String.self)
        do {
            try self.init(decoded)
        } catch {
            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: "Invalid profile name"
            )
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }
}

public struct MeshOrigin: RawRepresentable, Codable, Equatable, Hashable, Sendable {
    public let rawValue: String

    public var value: String { rawValue }

    public init(_ value: String, allowLoopbackHTTPForTests: Bool = false) throws {
        guard var components = URLComponents(string: value),
              let scheme = components.scheme?.lowercased(),
              let host = components.host?.lowercased(),
              !host.isEmpty,
              components.user == nil,
              components.password == nil,
              components.query == nil,
              components.fragment == nil,
              components.percentEncodedPath.isEmpty || components.percentEncodedPath == "/"
        else {
            throw ModelValidationError.invalidOrigin
        }

        let isLoopback = host == "localhost" || host == "127.0.0.1" || host == "::1" || host == "[::1]"
        guard scheme == "https" || (allowLoopbackHTTPForTests && scheme == "http" && isLoopback) else {
            throw ModelValidationError.invalidOrigin
        }

        components.scheme = scheme
        components.host = host
        components.path = ""
        components.percentEncodedQuery = nil
        components.percentEncodedFragment = nil
        guard let canonical = components.string else {
            throw ModelValidationError.invalidOrigin
        }
        rawValue = canonical
    }

    public init?(rawValue: String) {
        guard let value = try? MeshOrigin(rawValue) else { return nil }
        self = value
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        let decoded = try container.decode(String.self)
        do {
            try self.init(decoded)
        } catch {
            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: "Invalid MESH origin"
            )
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }
}

public struct AgentID: RawRepresentable, Codable, Equatable, Hashable, Sendable {
    public let rawValue: String

    public var value: String { rawValue }

    public init(_ value: String) throws {
        guard value.wholeMatch(of: /^agent_[a-f0-9]{32}$/) != nil else {
            throw ModelValidationError.invalidAgentID
        }
        rawValue = value
    }

    public init?(rawValue: String) {
        guard let value = try? AgentID(rawValue) else { return nil }
        self = value
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        let decoded = try container.decode(String.self)
        do {
            try self.init(decoded)
        } catch {
            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: "Invalid agent ID"
            )
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }
}

public struct MailboxHandle: RawRepresentable, Codable, Equatable, Hashable, Sendable {
    public let rawValue: String

    public var value: String { rawValue }

    public init(_ value: String) throws {
        guard (3...32).contains(value.utf8.count),
              value.wholeMatch(of: /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/) != nil
        else {
            throw ModelValidationError.invalidMailboxHandle
        }
        rawValue = value
    }

    public init?(rawValue: String) {
        guard let value = try? MailboxHandle(rawValue) else { return nil }
        self = value
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        let decoded = try container.decode(String.self)
        do {
            try self.init(decoded)
        } catch {
            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: "Invalid mailbox handle"
            )
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }
}

public struct MeshToken: Codable, Equatable, Hashable, Sendable,
    CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable
{
    let secretValue: String

    public init(_ value: String) throws {
        guard value.wholeMatch(of: /^mesh_[a-f0-9]{64}$/) != nil else {
            throw ModelValidationError.invalidToken
        }
        secretValue = value
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        let decoded = try container.decode(String.self)
        do {
            try self.init(decoded)
        } catch {
            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: "Invalid MESH token"
            )
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(secretValue)
    }

    public var description: String { "<redacted MESH token>" }

    public var debugDescription: String { description }

    public var customMirror: Mirror {
        Mirror(self, children: ["value": "<redacted>"], displayStyle: .struct)
    }
}

public struct CredentialBinding: Codable, Equatable, Sendable,
    CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable
{
    public let version: Int
    public let origin: MeshOrigin
    public let agentID: AgentID
    public let handle: MailboxHandle
    public let token: MeshToken

    public init(origin: MeshOrigin, agentID: AgentID, handle: MailboxHandle, token: MeshToken) {
        version = 1
        self.origin = origin
        self.agentID = agentID
        self.handle = handle
        self.token = token
    }

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case version
        case origin
        case agentID = "agentId"
        case handle
        case token
    }

    private struct AnyCodingKey: CodingKey {
        let stringValue: String
        let intValue: Int?

        init?(stringValue: String) {
            self.stringValue = stringValue
            intValue = nil
        }

        init?(intValue: Int) {
            stringValue = String(intValue)
            self.intValue = intValue
        }
    }

    public init(from decoder: Decoder) throws {
        let allValues = try decoder.container(keyedBy: AnyCodingKey.self)
        let expectedKeys = Set(CodingKeys.allCases.map(\.rawValue))
        let actualKeys = Set(allValues.allKeys.map(\.stringValue))
        guard actualKeys == expectedKeys else {
            throw DecodingError.dataCorrupted(
                .init(codingPath: decoder.codingPath, debugDescription: "Credential binding schema mismatch")
            )
        }

        let values = try decoder.container(keyedBy: CodingKeys.self)
        version = try values.decode(Int.self, forKey: .version)
        guard version == 1 else {
            throw DecodingError.dataCorruptedError(
                forKey: .version,
                in: values,
                debugDescription: "Unsupported credential binding version"
            )
        }
        origin = try values.decode(MeshOrigin.self, forKey: .origin)
        agentID = try values.decode(AgentID.self, forKey: .agentID)
        handle = try values.decode(MailboxHandle.self, forKey: .handle)
        token = try values.decode(MeshToken.self, forKey: .token)
    }

    public func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(version, forKey: .version)
        try values.encode(origin, forKey: .origin)
        try values.encode(agentID, forKey: .agentID)
        try values.encode(handle, forKey: .handle)
        try values.encode(token, forKey: .token)
    }

    public var description: String {
        "CredentialBinding(version: \(version), origin: \(origin.value), agentID: \(agentID.value), handle: \(handle.value), token: <redacted>)"
    }

    public var debugDescription: String { description }

    public var customMirror: Mirror {
        Mirror(
            self,
            children: [
                "version": version,
                "origin": origin.value,
                "agentID": agentID.value,
                "handle": handle.value,
                "token": "<redacted>",
            ],
            displayStyle: .struct
        )
    }
}

public enum HelperCommand: String, CaseIterable, Equatable, Sendable {
    case enroll
    case status
    case mcp
    case runWorker = "run-worker"
    case runSupervisor = "run-supervisor"
    case preflightSupervisor = "preflight-supervisor"
}

public enum WorkerKind: String, CaseIterable, Equatable, Sendable {
    case codex
    case hermes
    case antigravity
}

public struct ParsedCommand: Equatable, Sendable {
    public let command: HelperCommand
    public let profile: ProfileName?
    public let origin: MeshOrigin?
    public let worker: WorkerKind?
}

public enum CommandParseError: Error, Equatable, Sendable {
    case invalidCommand
    case missingRequiredFlag
    case unknownOrDuplicateFlag
    case invalidFlagValue
}

public enum CommandParser {
    public static func parse(_ arguments: [String]) throws -> ParsedCommand {
        guard let verb = arguments.first, let command = HelperCommand(rawValue: verb) else {
            throw CommandParseError.invalidCommand
        }

        if command == .runSupervisor || command == .preflightSupervisor {
            guard arguments.count == 1 else { throw CommandParseError.unknownOrDuplicateFlag }
            return ParsedCommand(command: command, profile: nil, origin: nil, worker: nil)
        }

        var flagValues: [String: String] = [:]
        var index = 1
        while index < arguments.count {
            let argument = arguments[index]
            guard argument.hasPrefix("--"), index + 1 < arguments.count else {
                throw CommandParseError.unknownOrDuplicateFlag
            }
            let value = arguments[index + 1]
            guard !value.hasPrefix("--"), flagValues[argument] == nil else {
                throw CommandParseError.unknownOrDuplicateFlag
            }
            flagValues[argument] = value
            index += 2
        }

        let allowedFlags: Set<String>
        switch command {
        case .enroll:
            allowedFlags = ["--profile", "--origin"]
        case .status, .mcp:
            allowedFlags = ["--profile"]
        case .runWorker:
            allowedFlags = ["--profile", "--worker"]
        case .runSupervisor, .preflightSupervisor:
            allowedFlags = []
        }
        guard Set(flagValues.keys).isSubset(of: allowedFlags) else {
            throw CommandParseError.unknownOrDuplicateFlag
        }

        guard let profileValue = flagValues["--profile"] else {
            throw CommandParseError.missingRequiredFlag
        }
        let profile: ProfileName
        do {
            profile = try ProfileName(profileValue)
        } catch {
            throw CommandParseError.invalidFlagValue
        }

        switch command {
        case .enroll:
            guard let originValue = flagValues["--origin"] else {
                throw CommandParseError.missingRequiredFlag
            }
            do {
                return ParsedCommand(
                    command: command,
                    profile: profile,
                    origin: try MeshOrigin(originValue),
                    worker: nil
                )
            } catch {
                throw CommandParseError.invalidFlagValue
            }
        case .status, .mcp:
            return ParsedCommand(
                command: command,
                profile: profile,
                origin: nil,
                worker: nil
            )
        case .runWorker:
            guard let workerValue = flagValues["--worker"] else {
                throw CommandParseError.missingRequiredFlag
            }
            guard let worker = WorkerKind(rawValue: workerValue) else {
                throw CommandParseError.invalidFlagValue
            }
            return ParsedCommand(
                command: command,
                profile: profile,
                origin: nil,
                worker: worker
            )
        case .runSupervisor, .preflightSupervisor:
            throw CommandParseError.invalidCommand
        }
    }
}
