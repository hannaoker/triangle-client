import Darwin
import Foundation

public enum ClientInstallationIdentityError: Error, Equatable, Sendable {
    case unsafeStorage
    case invalidRecord
}

public protocol ClientInstallationIdentityStore: Sendable {
    /// Returns the durable installation id, creating one if absent.
    func resolve() throws -> InstallationID
}

/// In-memory identity for contract tests and non-persistent hosts.
public final class InMemoryClientInstallationIdentityStore: ClientInstallationIdentityStore, @unchecked Sendable {
    private let lock = NSLock()
    private var installationID: InstallationID?

    public init(installationID: InstallationID? = nil) {
        self.installationID = installationID
    }

    public func resolve() throws -> InstallationID {
        try lock.withLock {
            if let installationID { return installationID }
            let generated = try InstallationID.generate()
            installationID = generated
            return generated
        }
    }
}

/// Durable installation id under Application Support (`client/installation.json`).
public final class FileClientInstallationIdentityStore: ClientInstallationIdentityStore, @unchecked Sendable {
    private static let maximumBytes = 512
    private let fileURL: URL
    private let managedDirectories: [URL]

    public convenience init() {
        let applicationRoot = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/The Triangle", isDirectory: true)
        let clientRoot = applicationRoot.appendingPathComponent("client", isDirectory: true)
        let fileURL = clientRoot.appendingPathComponent("installation.json")
        self.init(fileURL: fileURL, managedDirectories: [applicationRoot, clientRoot])
    }

    @_spi(ClientInstanceTesting)
    public convenience init(testRoot: URL) {
        let fileURL = testRoot.appendingPathComponent("installation.json")
        self.init(fileURL: fileURL, managedDirectories: [testRoot])
    }

    private init(fileURL: URL, managedDirectories: [URL]) {
        self.fileURL = fileURL
        self.managedDirectories = managedDirectories
    }

    public func resolve() throws -> InstallationID {
        try ensureManagedDirectories()
        if let existing = try? read() {
            return existing
        }
        let generated = try InstallationID.generate()
        try write(generated)
        return generated
    }

    private struct Record: Codable {
        let version: Int
        let installationId: String
    }

    private func read() throws -> InstallationID {
        var metadata = stat()
        guard lstat(fileURL.path, &metadata) == 0,
              (metadata.st_mode & S_IFMT) == S_IFREG,
              metadata.st_uid == getuid(),
              metadata.st_mode & 0o777 == 0o600,
              metadata.st_nlink == 1,
              metadata.st_size > 0,
              metadata.st_size <= Self.maximumBytes
        else { throw ClientInstallationIdentityError.unsafeStorage }
        let data = try Data(contentsOf: fileURL)
        guard data.count <= Self.maximumBytes else { throw ClientInstallationIdentityError.unsafeStorage }
        let record: Record
        do { record = try JSONDecoder().decode(Record.self, from: data) }
        catch { throw ClientInstallationIdentityError.invalidRecord }
        guard record.version == 1 else { throw ClientInstallationIdentityError.invalidRecord }
        do { return try InstallationID(record.installationId) }
        catch { throw ClientInstallationIdentityError.invalidRecord }
    }

    private func write(_ installationID: InstallationID) throws {
        try ensureManagedDirectories()
        let parent = fileURL.deletingLastPathComponent()
        let record = Record(version: 1, installationId: installationID.value)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let data = try encoder.encode(record)
        guard data.count <= Self.maximumBytes else { throw ClientInstallationIdentityError.invalidRecord }
        let temporary = parent.appendingPathComponent(".tmp-installation-\(UUID().uuidString)")
        let descriptor = open(temporary.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard descriptor >= 0 else { throw ClientInstallationIdentityError.unsafeStorage }
        do {
            guard fchmod(descriptor, 0o600) == 0 else { throw ClientInstallationIdentityError.unsafeStorage }
            try data.withUnsafeBytes { raw in
                var offset = 0
                while offset < data.count {
                    let count = Darwin.write(descriptor, raw.baseAddress!.advanced(by: offset), data.count - offset)
                    if count < 0 && errno == EINTR { continue }
                    guard count > 0 else { throw ClientInstallationIdentityError.unsafeStorage }
                    offset += count
                }
            }
            guard fsync(descriptor) == 0 else { throw ClientInstallationIdentityError.unsafeStorage }
        } catch {
            close(descriptor)
            unlink(temporary.path)
            throw error
        }
        close(descriptor)
        guard rename(temporary.path, fileURL.path) == 0 else {
            unlink(temporary.path)
            throw ClientInstallationIdentityError.unsafeStorage
        }
        let directory = open(parent.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard directory >= 0, fsync(directory) == 0 else {
            if directory >= 0 { close(directory) }
            throw ClientInstallationIdentityError.unsafeStorage
        }
        close(directory)
    }

    private func ensureManagedDirectories() throws {
        for directory in managedDirectories {
            var metadata = stat()
            if lstat(directory.path, &metadata) == 0 {
                guard (metadata.st_mode & S_IFMT) == S_IFDIR,
                      metadata.st_uid == getuid(),
                      metadata.st_mode & 0o777 == 0o700
                else { throw ClientInstallationIdentityError.unsafeStorage }
                continue
            }
            do {
                try FileManager.default.createDirectory(
                    at: directory,
                    withIntermediateDirectories: false,
                    attributes: [.posixPermissions: 0o700]
                )
            } catch {
                throw ClientInstallationIdentityError.unsafeStorage
            }
        }
    }
}
