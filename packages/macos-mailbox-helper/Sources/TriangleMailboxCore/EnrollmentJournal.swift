import Darwin
import Foundation

public enum EnrollmentJournalState: String, Codable, CaseIterable, Sendable {
    case pending
    case outcomeUnknown = "outcome_unknown"
    case registeredNotInstalled = "registered_not_installed"
    case pendingVerification = "pending_verification"
    case quarantined
    case verified
}

public struct EnrollmentJournalRecord: Codable, Equatable, Sendable,
    CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable
{
    public let version: Int
    public let profile: ProfileName
    public let origin: MeshOrigin
    public let state: EnrollmentJournalState
    public let agentID: AgentID?
    public let handle: MailboxHandle?
    public let reasonCode: String

    init(profile: ProfileName, origin: MeshOrigin, state: EnrollmentJournalState, agentID: AgentID?, handle: MailboxHandle?, reasonCode: String) throws {
        guard reasonCode.wholeMatch(of: /^[a-z][a-z0-9_]{0,63}$/) != nil else { throw EnrollmentJournalError.invalidRecord }
        version = 1
        self.profile = profile; self.origin = origin; self.state = state
        self.agentID = agentID; self.handle = handle; self.reasonCode = reasonCode
    }

    @_spi(EnrollmentTesting)
    public static func testing(profile: ProfileName, origin: MeshOrigin, state: EnrollmentJournalState, agentID: AgentID?, handle: MailboxHandle?, reasonCode: String) throws -> Self {
        try Self(profile: profile, origin: origin, state: state, agentID: agentID, handle: handle, reasonCode: reasonCode)
    }

    public var description: String { "EnrollmentJournalRecord(profile: \(profile.value), origin: \(origin.value), state: \(state.rawValue), agentID: \(agentID?.value ?? "none"), handle: \(handle?.value ?? "none"), reasonCode: \(reasonCode))" }
    public var debugDescription: String { description }
    public var customMirror: Mirror { Mirror(self, children: ["profile": profile.value, "origin": origin.value, "state": state.rawValue, "agentID": agentID?.value ?? "none", "handle": handle?.value ?? "none", "reasonCode": reasonCode], displayStyle: .struct) }

    private enum CodingKeys: String, CodingKey, CaseIterable { case version, profile, origin, state, agentID, handle, reasonCode }
    private struct AnyKey: CodingKey { let stringValue: String; let intValue: Int?; init?(stringValue: String) { self.stringValue = stringValue; intValue = nil }; init?(intValue: Int) { stringValue = String(intValue); self.intValue = intValue } }
    public init(from decoder: Decoder) throws {
        let all = try decoder.container(keyedBy: AnyKey.self)
        guard Set(all.allKeys.map(\.stringValue)) == Set(CodingKeys.allCases.map(\.rawValue)) else { throw EnrollmentJournalError.invalidRecord }
        let values = try decoder.container(keyedBy: CodingKeys.self)
        version = try values.decode(Int.self, forKey: .version)
        guard version == 1 else { throw EnrollmentJournalError.invalidRecord }
        profile = try values.decode(ProfileName.self, forKey: .profile)
        origin = try values.decode(MeshOrigin.self, forKey: .origin)
        state = try values.decode(EnrollmentJournalState.self, forKey: .state)
        agentID = try values.decodeIfPresent(AgentID.self, forKey: .agentID)
        handle = try values.decodeIfPresent(MailboxHandle.self, forKey: .handle)
        reasonCode = try values.decode(String.self, forKey: .reasonCode)
        guard reasonCode.wholeMatch(of: /^[a-z][a-z0-9_]{0,63}$/) != nil else { throw EnrollmentJournalError.invalidRecord }
    }
    public func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(version, forKey: .version); try values.encode(profile, forKey: .profile)
        try values.encode(origin, forKey: .origin); try values.encode(state, forKey: .state)
        if let agentID { try values.encode(agentID, forKey: .agentID) } else { try values.encodeNil(forKey: .agentID) }
        if let handle { try values.encode(handle, forKey: .handle) } else { try values.encodeNil(forKey: .handle) }
        try values.encode(reasonCode, forKey: .reasonCode)
    }
}

public enum EnrollmentJournalError: Error, Equatable, Sendable { case notFound, unsafeStorage, invalidRecord }
public protocol EnrollmentJournal: Sendable {
    func read(for profile: ProfileName) throws -> EnrollmentJournalRecord?
    func write(_ record: EnrollmentJournalRecord) throws
    func remove(for profile: ProfileName) throws
}

public final class InMemoryEnrollmentJournal: EnrollmentJournal, @unchecked Sendable {
    public static let shared = InMemoryEnrollmentJournal()
    private let lock = NSLock(); private var records: [ProfileName: EnrollmentJournalRecord] = [:]
    public init() {}
    public func read(for profile: ProfileName) throws -> EnrollmentJournalRecord? { lock.withLock { records[profile] } }
    public func write(_ record: EnrollmentJournalRecord) throws { lock.withLock { records[record.profile] = record } }
    public func remove(for profile: ProfileName) throws { _ = lock.withLock { records.removeValue(forKey: profile) } }
}

public final class FileEnrollmentJournal: EnrollmentJournal, @unchecked Sendable {
    private static let maximumBytes = 4096
    private let root: URL
    private let applicationRoot: URL?
    public convenience init() {
        let applicationRoot = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/The Triangle", isDirectory: true)
        self.init(root: applicationRoot.appendingPathComponent("enrollment-journal", isDirectory: true), applicationRoot: applicationRoot)
    }
    private init(root: URL, applicationRoot: URL?) { self.root = root; self.applicationRoot = applicationRoot }
    @_spi(EnrollmentTesting) public convenience init(testRoot: URL) { self.init(root: testRoot, applicationRoot: nil) }

    public func read(for profile: ProfileName) throws -> EnrollmentJournalRecord? {
        let dir = try openRoot(); defer { close(dir) }
        let fd = openat(dir, filename(profile), O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
        if fd < 0 { if errno == ENOENT { return nil }; throw EnrollmentJournalError.unsafeStorage }
        defer { close(fd) }; try validateFile(fd)
        var data = Data(); var buffer = [UInt8](repeating: 0, count: 1024)
        while true {
            let count = Darwin.read(fd, &buffer, buffer.count)
            guard count >= 0 else { throw EnrollmentJournalError.unsafeStorage }
            if count == 0 { break }; data.append(buffer, count: count)
            guard data.count <= Self.maximumBytes else { throw EnrollmentJournalError.invalidRecord }
        }
        do {
            let record = try JSONDecoder().decode(EnrollmentJournalRecord.self, from: data)
            guard record.profile == profile else { throw EnrollmentJournalError.invalidRecord }
            return record
        } catch let error as EnrollmentJournalError { throw error }
        catch { throw EnrollmentJournalError.invalidRecord }
    }

    public func write(_ record: EnrollmentJournalRecord) throws {
        let data = try JSONEncoder().encode(record); guard data.count <= Self.maximumBytes else { throw EnrollmentJournalError.invalidRecord }
        let dir = try openRoot(); defer { close(dir) }
        try validateExisting(dir: dir, name: filename(record.profile))
        let temp = ".tmp-\(UUID().uuidString.lowercased())"
        let fd = openat(dir, temp, O_CREAT | O_EXCL | O_WRONLY | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard fd >= 0 else { throw EnrollmentJournalError.unsafeStorage }
        var installed = false
        defer { close(fd); if !installed { _ = unlinkat(dir, temp, 0) } }
        guard fchmod(fd, 0o600) == 0 else { throw EnrollmentJournalError.unsafeStorage }
        try data.withUnsafeBytes { raw in
            var offset = 0
            while offset < raw.count {
                let count = Darwin.write(fd, raw.baseAddress!.advanced(by: offset), raw.count - offset)
                guard count > 0 else { throw EnrollmentJournalError.unsafeStorage }; offset += count
            }
        }
        guard fsync(fd) == 0, renameat(dir, temp, dir, filename(record.profile)) == 0, fsync(dir) == 0 else { throw EnrollmentJournalError.unsafeStorage }
        installed = true
    }

    public func remove(for profile: ProfileName) throws {
        let dir = try openRoot(); defer { close(dir) }
        let name = filename(profile); try validateExisting(dir: dir, name: name)
        if unlinkat(dir, name, 0) != 0 && errno != ENOENT { throw EnrollmentJournalError.unsafeStorage }
        guard fsync(dir) == 0 else { throw EnrollmentJournalError.unsafeStorage }
    }

    private func openRoot() throws -> Int32 {
        if let applicationRoot { try ensureSafeDirectory(applicationRoot, intermediate: true) }
        try ensureSafeDirectory(root, intermediate: false)
        let fd = open(root.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard fd >= 0 else { throw EnrollmentJournalError.unsafeStorage }; return fd
    }
    private func ensureSafeDirectory(_ directory: URL, intermediate: Bool) throws {
        var metadata = stat()
        if lstat(directory.path, &metadata) != 0 {
            do { try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: intermediate, attributes: [.posixPermissions: 0o700]) }
            catch { throw EnrollmentJournalError.unsafeStorage }
            guard lstat(directory.path, &metadata) == 0 else { throw EnrollmentJournalError.unsafeStorage }
        }
        guard (metadata.st_mode & S_IFMT) == S_IFDIR, metadata.st_uid == getuid(), (metadata.st_mode & 0o777) == 0o700 else { throw EnrollmentJournalError.unsafeStorage }
    }
    private func validateFile(_ fd: Int32) throws { var s = stat(); guard fstat(fd, &s) == 0, (s.st_mode & S_IFMT) == S_IFREG, s.st_uid == getuid(), (s.st_mode & 0o777) == 0o600 else { throw EnrollmentJournalError.unsafeStorage } }
    private func validateExisting(dir: Int32, name: String) throws { var s = stat(); if fstatat(dir, name, &s, AT_SYMLINK_NOFOLLOW) != 0 { if errno == ENOENT { return }; throw EnrollmentJournalError.unsafeStorage }; guard (s.st_mode & S_IFMT) == S_IFREG, s.st_uid == getuid(), (s.st_mode & 0o777) == 0o600 else { throw EnrollmentJournalError.unsafeStorage } }
    private func filename(_ profile: ProfileName) -> String { "profile-" + profile.value.utf8.map { String(format: "%02x", $0) }.joined() + ".json" }
}
