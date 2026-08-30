import Foundation

public enum CredentialReplacementConfirmation: Equatable, Sendable {
    case notConfirmed
    case confirmed
}

public enum CredentialStoreError: Error, Equatable, Sendable,
    CustomStringConvertible, CustomDebugStringConvertible
{
    case itemNotFound
    case interactionNotAllowed
    case duplicateItem
    case replacementNotConfirmed
    case invalidStoredCredential
    case keychainFailure

    public static let allBoundedCases: [CredentialStoreError] = [
        .itemNotFound,
        .interactionNotAllowed,
        .duplicateItem,
        .replacementNotConfirmed,
        .invalidStoredCredential,
        .keychainFailure,
    ]

    public var description: String {
        switch self {
        case .itemNotFound:
            "credential not found"
        case .interactionNotAllowed:
            "credential access is unavailable"
        case .duplicateItem:
            "credential already exists"
        case .replacementNotConfirmed:
            "credential replacement was not confirmed"
        case .invalidStoredCredential:
            "stored credential is invalid"
        case .keychainFailure:
            "credential storage failed"
        }
    }

    public var debugDescription: String { description }
}

public protocol CredentialStore: AnyObject, Sendable {
    func create(_ binding: CredentialBinding, for profile: ProfileName) throws
    func read(for profile: ProfileName) throws -> CredentialBinding
    func replace(
        _ binding: CredentialBinding,
        for profile: ProfileName,
        confirmation: CredentialReplacementConfirmation
    ) throws
    func delete(for profile: ProfileName) throws
}

public final class InMemoryCredentialStore: CredentialStore, @unchecked Sendable {
    private let lock = NSLock()
    private var bindings: [ProfileName: CredentialBinding] = [:]

    public init() {}

    public func create(_ binding: CredentialBinding, for profile: ProfileName) throws {
        lock.lock()
        defer { lock.unlock() }
        guard bindings[profile] == nil else {
            throw CredentialStoreError.duplicateItem
        }
        bindings[profile] = binding
    }

    public func read(for profile: ProfileName) throws -> CredentialBinding {
        lock.lock()
        defer { lock.unlock() }
        guard let binding = bindings[profile] else {
            throw CredentialStoreError.itemNotFound
        }
        return binding
    }

    public func replace(
        _ binding: CredentialBinding,
        for profile: ProfileName,
        confirmation: CredentialReplacementConfirmation
    ) throws {
        guard confirmation == .confirmed else {
            throw CredentialStoreError.replacementNotConfirmed
        }
        lock.lock()
        defer { lock.unlock() }
        guard bindings[profile] != nil else {
            throw CredentialStoreError.itemNotFound
        }
        bindings[profile] = binding
    }

    public func delete(for profile: ProfileName) throws {
        lock.lock()
        defer { lock.unlock() }
        guard bindings.removeValue(forKey: profile) != nil else {
            throw CredentialStoreError.itemNotFound
        }
    }
}
