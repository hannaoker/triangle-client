import Foundation

public enum WatchGrantValidationError: Error, Equatable, Sendable {
    case invalidInstallationID
    case invalidWatchGrantID
    case invalidWatchCredential
    case invalidStagingCredential
}

/// Installation-scoped MESH watch grant identifier (`inst_…`).
public struct InstallationID: RawRepresentable, Codable, Equatable, Hashable, Sendable {
    public let rawValue: String
    public var value: String { rawValue }

    public init(_ value: String) throws {
        guard value.wholeMatch(of: /^inst_[A-Za-z0-9_-]{10,75}$/) != nil else {
            throw WatchGrantValidationError.invalidInstallationID
        }
        rawValue = value
    }

    public init?(rawValue: String) {
        guard let value = try? InstallationID(rawValue) else { return nil }
        self = value
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        let decoded = try container.decode(String.self)
        do { try self.init(decoded) }
        catch {
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "Invalid installation ID")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }

    /// Generates a durable-looking installation id matching the MESH pattern.
    public static func generate() throws -> InstallationID {
        var generator = SystemRandomNumberGenerator()
        let alphabet = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-")
        let encoded = String((0..<16).map { _ in alphabet[Int.random(in: 0..<alphabet.count, using: &generator)] })
        return try InstallationID("inst_\(encoded)")
    }
}

public struct WatchGrantID: RawRepresentable, Codable, Equatable, Hashable, Sendable,
    CustomStringConvertible, CustomDebugStringConvertible
{
    public let rawValue: String
    public var value: String { rawValue }

    public init(_ value: String) throws {
        guard value.wholeMatch(of: /^watchgrant_[a-f0-9]{64}$/) != nil else {
            throw WatchGrantValidationError.invalidWatchGrantID
        }
        rawValue = value
    }

    public init?(rawValue: String) {
        guard let value = try? WatchGrantID(rawValue) else { return nil }
        self = value
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        let decoded = try container.decode(String.self)
        do { try self.init(decoded) }
        catch {
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "Invalid watch grant ID")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }

    public var description: String { rawValue }
    public var debugDescription: String { description }
}

public struct WatchStagingCredential: Codable, Equatable, Hashable, Sendable,
    CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable
{
    let secretValue: String

    public init(_ value: String) throws {
        guard value.wholeMatch(of: /^mesh_watch_stage_[a-f0-9]{64}$/) != nil else {
            throw WatchGrantValidationError.invalidStagingCredential
        }
        secretValue = value
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        let decoded = try container.decode(String.self)
        do { try self.init(decoded) }
        catch {
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "Invalid staging credential")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(secretValue)
    }

    public var description: String { "<redacted watch staging credential>" }
    public var debugDescription: String { description }
    public var customMirror: Mirror {
        Mirror(self, children: ["value": "<redacted>"], displayStyle: .struct)
    }
}

public struct WatchCredential: Codable, Equatable, Hashable, Sendable,
    CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable
{
    let secretValue: String

    public init(_ value: String) throws {
        guard value.wholeMatch(of: /^mesh_watch_[a-f0-9]{64}$/) != nil else {
            throw WatchGrantValidationError.invalidWatchCredential
        }
        secretValue = value
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        let decoded = try container.decode(String.self)
        do { try self.init(decoded) }
        catch {
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "Invalid watch credential")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(secretValue)
    }

    public var description: String { "<redacted watch credential>" }
    public var debugDescription: String { description }
    public var customMirror: Mirror {
        Mirror(self, children: ["value": "<redacted>"], displayStyle: .struct)
    }
}

/// Opaque finalized watch grant binding stored only in the signed helper Keychain.
public struct WatchGrantBinding: Codable, Equatable, Sendable,
    CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable
{
    public let version: Int
    public let installationID: InstallationID
    public let origin: MeshOrigin
    public let grantID: WatchGrantID
    public let agentIDs: [AgentID]
    public let watchCredential: WatchCredential
    public let audience: String
    public let purpose: String

    public init(
        installationID: InstallationID,
        origin: MeshOrigin,
        grantID: WatchGrantID,
        agentIDs: [AgentID],
        watchCredential: WatchCredential,
        audience: String = "mesh-mailbox-watch",
        purpose: String = "notification-only"
    ) {
        version = 1
        self.installationID = installationID
        self.origin = origin
        self.grantID = grantID
        self.agentIDs = agentIDs
        self.watchCredential = watchCredential
        self.audience = audience
        self.purpose = purpose
    }

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case version
        case installationID = "installationId"
        case origin
        case grantID = "grantId"
        case agentIDs = "agentIds"
        case watchCredential
        case audience
        case purpose
    }

    private struct AnyCodingKey: CodingKey {
        let stringValue: String
        let intValue: Int?
        init?(stringValue: String) { self.stringValue = stringValue; intValue = nil }
        init?(intValue: Int) { stringValue = String(intValue); self.intValue = intValue }
    }

    public init(from decoder: Decoder) throws {
        let allValues = try decoder.container(keyedBy: AnyCodingKey.self)
        let expectedKeys = Set(CodingKeys.allCases.map(\.rawValue))
        let actualKeys = Set(allValues.allKeys.map(\.stringValue))
        guard actualKeys == expectedKeys else {
            throw DecodingError.dataCorrupted(
                .init(codingPath: decoder.codingPath, debugDescription: "Watch grant binding schema mismatch")
            )
        }
        let values = try decoder.container(keyedBy: CodingKeys.self)
        version = try values.decode(Int.self, forKey: .version)
        guard version == 1 else {
            throw DecodingError.dataCorruptedError(forKey: .version, in: values, debugDescription: "Unsupported watch grant binding version")
        }
        installationID = try values.decode(InstallationID.self, forKey: .installationID)
        origin = try values.decode(MeshOrigin.self, forKey: .origin)
        grantID = try values.decode(WatchGrantID.self, forKey: .grantID)
        agentIDs = try values.decode([AgentID].self, forKey: .agentIDs)
        watchCredential = try values.decode(WatchCredential.self, forKey: .watchCredential)
        audience = try values.decode(String.self, forKey: .audience)
        purpose = try values.decode(String.self, forKey: .purpose)
        guard audience == "mesh-mailbox-watch", purpose == "notification-only", !agentIDs.isEmpty else {
            throw DecodingError.dataCorrupted(
                .init(codingPath: decoder.codingPath, debugDescription: "Watch grant binding fields are invalid")
            )
        }
    }

    public func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(version, forKey: .version)
        try values.encode(installationID, forKey: .installationID)
        try values.encode(origin, forKey: .origin)
        try values.encode(grantID, forKey: .grantID)
        try values.encode(agentIDs, forKey: .agentIDs)
        try values.encode(watchCredential, forKey: .watchCredential)
        try values.encode(audience, forKey: .audience)
        try values.encode(purpose, forKey: .purpose)
    }

    public var description: String {
        "WatchGrantBinding(version: \(version), installationID: \(installationID.value), origin: \(origin.value), grantID: \(grantID.value), agentIDs: \(agentIDs.count), watchCredential: <redacted>, audience: \(audience), purpose: \(purpose))"
    }

    public var debugDescription: String { description }

    public var customMirror: Mirror {
        Mirror(
            self,
            children: [
                "version": version,
                "installationID": installationID.value,
                "origin": origin.value,
                "grantID": grantID.value,
                "agentIDs": agentIDs.map(\.value),
                "watchCredential": "<redacted>",
                "audience": audience,
                "purpose": purpose,
            ],
            displayStyle: .struct
        )
    }
}

public struct StagedWatchGrant: Equatable, Sendable,
    CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable
{
    public let grantID: WatchGrantID
    public let installationID: InstallationID
    public let agentIDs: [AgentID]
    public let stagingCredential: WatchStagingCredential
    public let expiresAt: String
    public let audience: String
    public let purpose: String

    public init(
        grantID: WatchGrantID,
        installationID: InstallationID,
        agentIDs: [AgentID],
        stagingCredential: WatchStagingCredential,
        expiresAt: String,
        audience: String,
        purpose: String
    ) {
        self.grantID = grantID
        self.installationID = installationID
        self.agentIDs = agentIDs
        self.stagingCredential = stagingCredential
        self.expiresAt = expiresAt
        self.audience = audience
        self.purpose = purpose
    }

    public var description: String {
        "StagedWatchGrant(grantID: \(grantID.value), installationID: \(installationID.value), agentIDs: \(agentIDs.count), stagingCredential: <redacted>, expiresAt: \(expiresAt))"
    }
    public var debugDescription: String { description }
    public var customMirror: Mirror {
        Mirror(self, children: [
            "grantID": grantID.value,
            "installationID": installationID.value,
            "agentIDs": agentIDs.count,
            "stagingCredential": "<redacted>",
            "expiresAt": expiresAt,
        ], displayStyle: .struct)
    }
}

public struct FinalizedWatchGrant: Equatable, Sendable,
    CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable
{
    public let grantID: WatchGrantID
    public let watchCredential: WatchCredential
    public let audience: String
    public let purpose: String

    public var description: String {
        "FinalizedWatchGrant(grantID: \(grantID.value), watchCredential: <redacted>, audience: \(audience), purpose: \(purpose))"
    }
    public var debugDescription: String { description }
    public var customMirror: Mirror {
        Mirror(self, children: [
            "grantID": grantID.value,
            "watchCredential": "<redacted>",
            "audience": audience,
            "purpose": purpose,
        ], displayStyle: .struct)
    }
}

public struct WatchPollEvent: Codable, Equatable, Sendable {
    public let agentID: String
    public let highWatermark: Int

    public init(agentID: String, highWatermark: Int) {
        self.agentID = agentID
        self.highWatermark = highWatermark
    }

    private enum CodingKeys: String, CodingKey {
        case agentID = "agent_id"
        case highWatermark = "high_watermark"
    }
}

public struct WatchPollResponse: Codable, Equatable, Sendable {
    public let cursor: Int
    public let events: [WatchPollEvent]

    public init(cursor: Int, events: [WatchPollEvent]) {
        self.cursor = cursor
        self.events = events
    }
}

/// Secret-free operator surface for installation-scoped watch grants.
public struct WatchGrantOperatorStatus: Codable, Equatable, Sendable {
    public let installationID: String
    public let origin: String?
    public let grantID: String?
    public let agentIDs: [String]
    public let state: String
    public let audience: String?
    public let purpose: String?

    private enum CodingKeys: String, CodingKey {
        case installationID = "installationId"
        case origin
        case grantID = "grantId"
        case agentIDs = "agentIds"
        case state, audience, purpose
    }

    public init(
        installationID: String,
        origin: String?,
        grantID: String?,
        agentIDs: [String],
        state: String,
        audience: String?,
        purpose: String?
    ) {
        self.installationID = installationID
        self.origin = origin
        self.grantID = grantID
        self.agentIDs = agentIDs
        self.state = state
        self.audience = audience
        self.purpose = purpose
    }
}

public enum WatchGrantOperatorStatusRenderer {
    public static func render(_ status: WatchGrantOperatorStatus) throws -> RenderedCLIOutput {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        var stdout = try encoder.encode(status)
        stdout.append(0x0a)
        let exitCode: Int32 = status.state == "finalized" ? 0 : 1
        return RenderedCLIOutput(stdout: stdout, stderr: Data(), exitCode: exitCode)
    }
}
