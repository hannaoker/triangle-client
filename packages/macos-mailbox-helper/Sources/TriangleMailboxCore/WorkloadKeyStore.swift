import CryptoKit
import Foundation

public enum WorkloadKeyStoreError: Error, Equatable, Sendable, CustomStringConvertible, CustomDebugStringConvertible {
    case itemNotFound
    case interactionNotAllowed
    case duplicateItem
    case invalidStoredKey
    case keychainFailure

    public var description: String {
        switch self {
        case .itemNotFound: "workload key not found"
        case .interactionNotAllowed: "workload key access is unavailable"
        case .duplicateItem: "workload key already exists"
        case .invalidStoredKey: "stored workload key is invalid"
        case .keychainFailure: "workload key storage failed"
        }
    }

    public var debugDescription: String { description }
}

public struct WorkloadKeyRecord: Equatable, Sendable {
    public let privateKey: Curve25519.Signing.PrivateKey
    public let workloadID: WorkloadID?
    /// The v1 scopes this workload may request (its registered bounds).
    public let scopes: [String]

    public init(privateKey: Curve25519.Signing.PrivateKey, workloadID: WorkloadID? = nil, scopes: [String] = V1AgentMaterial.agentBounds) {
        self.privateKey = privateKey
        self.workloadID = workloadID
        self.scopes = scopes
    }

    public static func == (lhs: WorkloadKeyRecord, rhs: WorkloadKeyRecord) -> Bool {
        lhs.privateKey.rawRepresentation == rhs.privateKey.rawRepresentation && lhs.workloadID == rhs.workloadID && lhs.scopes == rhs.scopes
    }
}

public protocol WorkloadKeyStore: AnyObject, Sendable {
    func create(_ key: Curve25519.Signing.PrivateKey, workloadID: WorkloadID?, for profile: ProfileName) throws
    func read(for profile: ProfileName) throws -> WorkloadKeyRecord
    func delete(for profile: ProfileName) throws
}

public extension WorkloadKeyStore {
    func create(_ key: Curve25519.Signing.PrivateKey, for profile: ProfileName) throws {
        try create(key, workloadID: nil, for: profile)
    }
}

public final class InMemoryWorkloadKeyStore: WorkloadKeyStore, @unchecked Sendable {
    private let lock = NSLock()
    private var records: [ProfileName: WorkloadKeyRecord] = [:]

    public init() {}

    public func create(_ key: Curve25519.Signing.PrivateKey, workloadID: WorkloadID?, for profile: ProfileName) throws {
        lock.lock()
        defer { lock.unlock() }
        guard records[profile] == nil else { throw WorkloadKeyStoreError.duplicateItem }
        records[profile] = WorkloadKeyRecord(privateKey: key, workloadID: workloadID)
    }

    public func read(for profile: ProfileName) throws -> WorkloadKeyRecord {
        lock.lock()
        defer { lock.unlock() }
        guard let record = records[profile] else { throw WorkloadKeyStoreError.itemNotFound }
        return record
    }

    public func delete(for profile: ProfileName) throws {
        lock.lock()
        defer { lock.unlock() }
        records.removeValue(forKey: profile)
    }
}
