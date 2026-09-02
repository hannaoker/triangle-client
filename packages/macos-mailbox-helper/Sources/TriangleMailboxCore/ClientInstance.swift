import CryptoKit
import Foundation

public enum RuntimeAdapter: String, Codable, CaseIterable, Sendable {
    case codex
    case hermes
    case antigravity
}

public enum DeliveryMode: String, Codable, CaseIterable, Sendable {
    case worker
    case mcpInteractive = "mcp-interactive"
}

public struct ClientInstanceID: RawRepresentable, Codable, Equatable, Hashable, Sendable {
    public let rawValue: String
    public var value: String { rawValue }

    public init?(rawValue: String) {
        guard rawValue.wholeMatch(of: /^[a-f0-9]{64}$/) != nil else { return nil }
        self.rawValue = rawValue
    }

    public static func derive(profile: ProfileName) -> Self {
        var framed = Data("triangle-client-instance-v1".utf8)
        framed.append(0)
        framed.append(contentsOf: profile.value.utf8)
        let digest = SHA256.hash(data: framed).map { String(format: "%02x", $0) }.joined()
        return Self(rawValue: digest)!
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        let value = try container.decode(String.self)
        guard let identifier = Self(rawValue: value) else {
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "Invalid Triangle Client instance ID")
        }
        self = identifier
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }
}

public struct ClientInstance: Codable, Equatable, Sendable {
    public let version: Int
    public let instanceID: ClientInstanceID
    public let profile: ProfileName
    public let runtimeAdapter: RuntimeAdapter
    public let enabled: Bool
    public let deliveryMode: DeliveryMode

    public var participatesInWorkerPolling: Bool { enabled && deliveryMode == .worker }

    public init(
        profile: ProfileName,
        runtimeAdapter: RuntimeAdapter,
        enabled: Bool = true,
        deliveryMode: DeliveryMode = .worker
    ) throws {
        version = 1
        instanceID = .derive(profile: profile)
        self.profile = profile
        self.runtimeAdapter = runtimeAdapter
        self.enabled = enabled
        self.deliveryMode = deliveryMode
    }

    func settingEnabled(_ enabled: Bool) throws -> Self {
        try Self(profile: profile, runtimeAdapter: runtimeAdapter, enabled: enabled, deliveryMode: deliveryMode)
    }

    func settingDeliveryMode(_ deliveryMode: DeliveryMode) throws -> Self {
        try Self(profile: profile, runtimeAdapter: runtimeAdapter, enabled: enabled, deliveryMode: deliveryMode)
    }

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case version, instanceID = "instanceId", profile, runtimeAdapter, enabled, deliveryMode
    }

    private static let requiredLegacyKeys: Set<String> = [
        CodingKeys.version.rawValue,
        CodingKeys.instanceID.rawValue,
        CodingKeys.profile.rawValue,
        CodingKeys.runtimeAdapter.rawValue,
        CodingKeys.enabled.rawValue,
    ]

    private struct AnyKey: CodingKey {
        let stringValue: String
        let intValue: Int?
        init?(stringValue: String) { self.stringValue = stringValue; intValue = nil }
        init?(intValue: Int) { stringValue = String(intValue); self.intValue = intValue }
    }

    public init(from decoder: Decoder) throws {
        let all = try decoder.container(keyedBy: AnyKey.self)
        let presentKeys = Set(all.allKeys.map(\.stringValue))
        let allowedKeys = Set(CodingKeys.allCases.map(\.rawValue))
        guard presentKeys.isSubset(of: allowedKeys), Self.requiredLegacyKeys.isSubset(of: presentKeys) else {
            throw ClientInstanceStoreError.invalidRecord
        }
        let values = try decoder.container(keyedBy: CodingKeys.self)
        version = try values.decode(Int.self, forKey: .version)
        guard version == 1 else { throw ClientInstanceStoreError.invalidRecord }
        instanceID = try values.decode(ClientInstanceID.self, forKey: .instanceID)
        profile = try values.decode(ProfileName.self, forKey: .profile)
        runtimeAdapter = try values.decode(RuntimeAdapter.self, forKey: .runtimeAdapter)
        enabled = try values.decode(Bool.self, forKey: .enabled)
        deliveryMode = try values.decodeIfPresent(DeliveryMode.self, forKey: .deliveryMode) ?? .worker
        guard instanceID == .derive(profile: profile) else { throw ClientInstanceStoreError.invalidRecord }
    }
}
