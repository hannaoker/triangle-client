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
    case watchEnsure = "watch-ensure"
    case watchStatus = "watch-status"
    case watchRevoke = "watch-revoke"
    case watchPoll = "watch-poll"
    case transactionPreflight = "transaction-preflight"
    case transactionStatus = "transaction-status"
    case transactionClaim = "transaction-claim"
    case transactionReply = "transaction-reply"
    case transactionAck = "transaction-ack"
    case transactionAbandon = "transaction-abandon"
    case transactionRecordFailure = "transaction-record-failure"
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
    public let installationID: InstallationID?
    public let cursor: Int?
    public let protocolOwnership: MailboxTransactionProtocol?
    public let deliveryID: Int?
    public let roomID: String?
    public let eventID: String?
    public let failureReason: String?
    public let confirmAbandon: Bool

    public init(
        command: HelperCommand,
        profile: ProfileName? = nil,
        origin: MeshOrigin? = nil,
        worker: WorkerKind? = nil,
        installationID: InstallationID? = nil,
        cursor: Int? = nil,
        protocolOwnership: MailboxTransactionProtocol? = nil,
        deliveryID: Int? = nil,
        roomID: String? = nil,
        eventID: String? = nil,
        failureReason: String? = nil,
        confirmAbandon: Bool = false
    ) {
        self.command = command
        self.profile = profile
        self.origin = origin
        self.worker = worker
        self.installationID = installationID
        self.cursor = cursor
        self.protocolOwnership = protocolOwnership
        self.deliveryID = deliveryID
        self.roomID = roomID
        self.eventID = eventID
        self.failureReason = failureReason
        self.confirmAbandon = confirmAbandon
    }
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
            return ParsedCommand(command: command)
        }

        if command == .watchEnsure || command == .watchStatus || command == .watchRevoke || command == .watchPoll {
            return try parseWatchCommand(command, Array(arguments.dropFirst()))
        }

        if command == .transactionPreflight
            || command == .transactionStatus
            || command == .transactionClaim
            || command == .transactionReply
            || command == .transactionAck
            || command == .transactionAbandon
            || command == .transactionRecordFailure
        {
            return try parseTransactionCommand(command, Array(arguments.dropFirst()))
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
        case .runSupervisor, .preflightSupervisor, .watchEnsure, .watchStatus, .watchRevoke, .watchPoll,
             .transactionPreflight, .transactionStatus, .transactionClaim, .transactionReply,
             .transactionAck, .transactionAbandon, .transactionRecordFailure:
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
                    origin: try MeshOrigin(originValue)
                )
            } catch {
                throw CommandParseError.invalidFlagValue
            }
        case .status, .mcp:
            return ParsedCommand(command: command, profile: profile)
        case .runWorker:
            guard let workerValue = flagValues["--worker"] else {
                throw CommandParseError.missingRequiredFlag
            }
            guard let worker = WorkerKind(rawValue: workerValue) else {
                throw CommandParseError.invalidFlagValue
            }
            return ParsedCommand(command: command, profile: profile, worker: worker)
        case .runSupervisor, .preflightSupervisor, .watchEnsure, .watchStatus, .watchRevoke, .watchPoll,
             .transactionPreflight, .transactionStatus, .transactionClaim, .transactionReply,
             .transactionAck, .transactionAbandon, .transactionRecordFailure:
            throw CommandParseError.invalidCommand
        }
    }

    private static func parseTransactionCommand(_ command: HelperCommand, _ flags: [String]) throws -> ParsedCommand {
        var flagValues: [String: String] = [:]
        var confirmAbandon = false
        var index = 0
        while index < flags.count {
            let argument = flags[index]
            if argument == "--confirm" {
                guard !confirmAbandon else { throw CommandParseError.unknownOrDuplicateFlag }
                confirmAbandon = true
                index += 1
                continue
            }
            guard argument.hasPrefix("--"), index + 1 < flags.count else {
                throw CommandParseError.unknownOrDuplicateFlag
            }
            let value = flags[index + 1]
            guard !value.hasPrefix("--"), flagValues[argument] == nil else {
                throw CommandParseError.unknownOrDuplicateFlag
            }
            flagValues[argument] = value
            index += 2
        }

        let allowedFlags: Set<String>
        switch command {
        case .transactionStatus:
            allowedFlags = ["--profile", "--protocol"]
        case .transactionPreflight, .transactionAck, .transactionReply:
            allowedFlags = ["--profile", "--protocol"]
        case .transactionClaim:
            allowedFlags = ["--profile", "--protocol", "--delivery-id", "--room-id", "--event-id"]
        case .transactionAbandon:
            allowedFlags = ["--profile", "--protocol"]
        case .transactionRecordFailure:
            allowedFlags = ["--profile", "--protocol", "--reason"]
        default:
            throw CommandParseError.invalidCommand
        }
        guard Set(flagValues.keys) == allowedFlags else {
            throw CommandParseError.unknownOrDuplicateFlag
        }
        if command == .transactionAbandon {
            guard confirmAbandon else { throw CommandParseError.missingRequiredFlag }
        } else if confirmAbandon {
            throw CommandParseError.unknownOrDuplicateFlag
        }

        guard let profileValue = flagValues["--profile"],
              let protocolValue = flagValues["--protocol"],
              let protocolOwnership = MailboxTransactionProtocol(rawValue: protocolValue)
        else { throw CommandParseError.invalidFlagValue }
        let profile: ProfileName
        do { profile = try ProfileName(profileValue) }
        catch { throw CommandParseError.invalidFlagValue }

        switch command {
        case .transactionStatus, .transactionPreflight, .transactionReply, .transactionAck:
            return ParsedCommand(command: command, profile: profile, protocolOwnership: protocolOwnership)
        case .transactionAbandon:
            return ParsedCommand(
                command: command,
                profile: profile,
                protocolOwnership: protocolOwnership,
                confirmAbandon: true
            )
        case .transactionRecordFailure:
            guard let reason = flagValues["--reason"],
                  reason.wholeMatch(of: /^[a-z][a-z0-9_]{0,63}$/) != nil
            else { throw CommandParseError.invalidFlagValue }
            return ParsedCommand(
                command: command,
                profile: profile,
                protocolOwnership: protocolOwnership,
                failureReason: reason
            )
        case .transactionClaim:
            guard let deliveryRaw = flagValues["--delivery-id"],
                  let deliveryID = Int(deliveryRaw),
                  deliveryID > 0,
                  String(deliveryID) == deliveryRaw,
                  let roomID = flagValues["--room-id"],
                  MailboxRoomID(rawValue: roomID) != nil,
                  let eventID = flagValues["--event-id"],
                  MailboxEventID(rawValue: eventID) != nil
            else { throw CommandParseError.invalidFlagValue }
            return ParsedCommand(
                command: command,
                profile: profile,
                protocolOwnership: protocolOwnership,
                deliveryID: deliveryID,
                roomID: roomID,
                eventID: eventID
            )
        default:
            throw CommandParseError.invalidCommand
        }
    }

    private static func parseWatchCommand(_ command: HelperCommand, _ flags: [String]) throws -> ParsedCommand {
        var flagValues: [String: String] = [:]
        var index = 0
        while index < flags.count {
            let argument = flags[index]
            guard argument.hasPrefix("--"), index + 1 < flags.count else {
                throw CommandParseError.unknownOrDuplicateFlag
            }
            let value = flags[index + 1]
            guard !value.hasPrefix("--"), flagValues[argument] == nil else {
                throw CommandParseError.unknownOrDuplicateFlag
            }
            flagValues[argument] = value
            index += 2
        }

        let allowedFlags: Set<String>
        switch command {
        case .watchEnsure:
            allowedFlags = ["--installation", "--actor-profile"]
        case .watchStatus, .watchRevoke:
            allowedFlags = ["--installation"]
        case .watchPoll:
            allowedFlags = ["--installation", "--cursor"]
        default:
            throw CommandParseError.invalidCommand
        }
        guard Set(flagValues.keys) == allowedFlags else {
            throw CommandParseError.unknownOrDuplicateFlag
        }

        guard let installationValue = flagValues["--installation"] else {
            throw CommandParseError.missingRequiredFlag
        }
        let installationID: InstallationID
        do {
            installationID = try InstallationID(installationValue)
        } catch {
            throw CommandParseError.invalidFlagValue
        }

        switch command {
        case .watchEnsure:
            guard let actorValue = flagValues["--actor-profile"] else {
                throw CommandParseError.missingRequiredFlag
            }
            do {
                return ParsedCommand(
                    command: command,
                    profile: try ProfileName(actorValue),
                    installationID: installationID
                )
            } catch {
                throw CommandParseError.invalidFlagValue
            }
        case .watchStatus, .watchRevoke:
            return ParsedCommand(command: command, installationID: installationID)
        case .watchPoll:
            guard let cursorValue = flagValues["--cursor"], let cursor = Int(cursorValue), cursor >= 0,
                  String(cursor) == cursorValue
            else {
                throw CommandParseError.invalidFlagValue
            }
            return ParsedCommand(command: command, installationID: installationID, cursor: cursor)
        default:
            throw CommandParseError.invalidCommand
        }
    }
}
