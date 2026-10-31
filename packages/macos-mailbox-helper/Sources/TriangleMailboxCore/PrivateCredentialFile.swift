import Darwin
import Foundation

/// File custody for unattended CLI homes. Read through a no-follow descriptor;
/// create secret-bearing files with 0600 from the first byte, before publishing.
enum PrivateCredentialFile {
    enum StorageError: Error { case unsafeStorage }

    static func prepareDirectory(_ directory: URL, managedRoot: URL? = nil) throws {
        if let managedRoot {
            let base = managedRoot.standardizedFileURL
            let target = directory.standardizedFileURL
            guard target.path.hasPrefix(base.path + "/") else { throw StorageError.unsafeStorage }
            try prepareDirectory(base)
            var current = base
            for component in target.path.dropFirst(base.path.count + 1).split(separator: "/") {
                current.appendPathComponent(String(component), isDirectory: true)
                try prepareDirectory(current)
            }
            return
        }
        var metadata = stat()
        if lstat(directory.path, &metadata) != 0 {
            let code = errno
            try CLIStorageError.checkAccess("inspect credential directory", code: code)
            guard code == ENOENT else { throw StorageError.unsafeStorage }
            let parent = directory.deletingLastPathComponent()
            // Normal CLI use has already prepared the home via its reservation.
            // Create only missing parents; never chmod an existing directory.
            guard parent.path != directory.path else { throw StorageError.unsafeStorage }
            if !FileManager.default.fileExists(atPath: parent.path) { try prepareDirectory(parent) }
            if mkdir(directory.path, 0o700) != 0 && errno != EEXIST {
                try CLIStorageError.checkAccess("create credential directory")
                throw StorageError.unsafeStorage
            }
            guard lstat(directory.path, &metadata) == 0 else { throw StorageError.unsafeStorage }
        }
        guard (metadata.st_mode & S_IFMT) == S_IFDIR, metadata.st_uid == getuid(),
              metadata.st_mode & 0o777 == 0o700 else { throw StorageError.unsafeStorage }
    }

    static func read(_ url: URL) throws -> Data? {
        let fd = open(url.path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
        guard fd >= 0 else {
            let code = errno
            if code == ENOENT { return nil }
            try CLIStorageError.checkAccess("read credential file", code: code)
            throw StorageError.unsafeStorage
        }
        defer { close(fd) }
        var metadata = stat()
        guard fstat(fd, &metadata) == 0, (metadata.st_mode & S_IFMT) == S_IFREG,
              metadata.st_uid == getuid(), metadata.st_mode & 0o777 == 0o600,
              metadata.st_nlink == 1 else { throw StorageError.unsafeStorage }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while true {
            let count = Darwin.read(fd, &buffer, buffer.count)
            if count < 0 && errno == EINTR { continue }
            guard count >= 0 else { throw StorageError.unsafeStorage }
            if count == 0 { return data }
            data.append(buffer, count: count)
            guard data.count <= 64 * 1024 else { throw StorageError.unsafeStorage }
        }
    }

    static func write(_ data: Data, to url: URL) throws {
        let directory = open(url.deletingLastPathComponent().path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard directory >= 0 else {
            try CLIStorageError.checkAccess("open credential directory")
            throw StorageError.unsafeStorage
        }
        defer { close(directory) }
        let temporary = ".tmp-\(UUID().uuidString)"
        let fd = openat(directory, temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard fd >= 0 else {
            try CLIStorageError.checkAccess("write credential file")
            throw StorageError.unsafeStorage
        }
        defer { close(fd); _ = unlinkat(directory, temporary, 0) }
        guard fchmod(fd, 0o600) == 0 else { throw StorageError.unsafeStorage }
        try data.withUnsafeBytes { bytes in
            var offset = 0
            while offset < bytes.count {
                let count = Darwin.write(fd, bytes.baseAddress!.advanced(by: offset), bytes.count - offset)
                if count < 0 && errno == EINTR { continue }
                guard count > 0 else { throw StorageError.unsafeStorage }
                offset += count
            }
        }
        guard fsync(fd) == 0, renameat(directory, temporary, directory, url.lastPathComponent) == 0,
              fsync(directory) == 0 else { throw StorageError.unsafeStorage }
    }
}
