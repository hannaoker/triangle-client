import Darwin
import Foundation

public enum EnrollmentReservationError: Error, Equatable, Sendable {
    case alreadyInProgress
    case unsafeReservation
}

public protocol EnrollmentReservationLease: AnyObject, Sendable {
    func release()
}

public protocol EnrollmentReservation: Sendable {
    func acquire(for profile: ProfileName) throws -> any EnrollmentReservationLease
}

public final class InMemoryEnrollmentReservation: EnrollmentReservation, @unchecked Sendable {
    public static let shared = InMemoryEnrollmentReservation()
    private let lock = NSLock()
    private var profiles: Set<ProfileName> = []

    public init() {}

    public func acquire(for profile: ProfileName) throws -> any EnrollmentReservationLease {
        try lock.withLock {
            guard profiles.insert(profile).inserted else { throw EnrollmentReservationError.alreadyInProgress }
        }
        return MemoryReservationLease { [weak self] in
            _ = self?.lock.withLock { self?.profiles.remove(profile) }
        }
    }
}

private final class MemoryReservationLease: EnrollmentReservationLease, @unchecked Sendable {
    private let lock = NSLock()
    private var releaseAction: (@Sendable () -> Void)?
    init(releaseAction: @escaping @Sendable () -> Void) { self.releaseAction = releaseAction }
    func release() { lock.withLock { let action = releaseAction; releaseAction = nil; action?() } }
    deinit { release() }
}

public final class FileEnrollmentReservation: EnrollmentReservation, @unchecked Sendable {
    private let root: URL
    private let applicationRoot: URL?

    public convenience init() {
        let applicationRoot = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/The Triangle", isDirectory: true)
        self.init(root: applicationRoot.appendingPathComponent("enrollment-locks", isDirectory: true), applicationRoot: applicationRoot)
    }

    private init(root: URL, applicationRoot: URL?) { self.root = root; self.applicationRoot = applicationRoot }

    @_spi(ReservationTesting)
    public convenience init(testRoot: URL) { self.init(root: testRoot, applicationRoot: nil) }

    public func acquire(for profile: ProfileName) throws -> any EnrollmentReservationLease {
        try ensureSafeRoot()
        let directoryFD = open(root.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard directoryFD >= 0 else { throw EnrollmentReservationError.unsafeReservation }
        defer { close(directoryFD) }

        let filename = Self.lockFileName(for: profile)
        let descriptor = openat(directoryFD, filename, O_CREAT | O_RDWR | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard descriptor >= 0 else { throw EnrollmentReservationError.unsafeReservation }
        var metadata = stat()
        guard fstat(descriptor, &metadata) == 0,
              (metadata.st_mode & S_IFMT) == S_IFREG,
              metadata.st_uid == getuid(),
              (metadata.st_mode & 0o777) == 0o600
        else {
            close(descriptor)
            throw EnrollmentReservationError.unsafeReservation
        }
        guard flock(descriptor, LOCK_EX | LOCK_NB) == 0 else {
            close(descriptor)
            if errno == EWOULDBLOCK { throw EnrollmentReservationError.alreadyInProgress }
            throw EnrollmentReservationError.unsafeReservation
        }
        return FileReservationLease(descriptor: descriptor)
    }

    private func ensureSafeRoot() throws {
        if let applicationRoot {
            try ensureSafeDirectory(applicationRoot, allowIntermediateCreation: true)
        }
        try ensureSafeDirectory(root, allowIntermediateCreation: false)
    }

    private func ensureSafeDirectory(_ directory: URL, allowIntermediateCreation: Bool) throws {
        var metadata = stat()
        if lstat(directory.path, &metadata) != 0 {
            guard errno == ENOENT else { throw EnrollmentReservationError.unsafeReservation }
            do {
                try FileManager.default.createDirectory(
                    at: directory,
                    withIntermediateDirectories: allowIntermediateCreation,
                    attributes: [.posixPermissions: 0o700]
                )
            } catch {
                throw EnrollmentReservationError.unsafeReservation
            }
            guard lstat(directory.path, &metadata) == 0 else { throw EnrollmentReservationError.unsafeReservation }
        }
        guard (metadata.st_mode & S_IFMT) == S_IFDIR,
              metadata.st_uid == getuid(),
              (metadata.st_mode & 0o777) == 0o700
        else { throw EnrollmentReservationError.unsafeReservation }
    }

    @_spi(ReservationTesting)
    public static func lockFileName(for profile: ProfileName) -> String {
        let hex = profile.value.utf8.map { String(format: "%02x", $0) }.joined()
        return "enroll-\(hex).lock"
    }
}

private final class FileReservationLease: EnrollmentReservationLease, @unchecked Sendable {
    private let lock = NSLock()
    private var descriptor: Int32?
    init(descriptor: Int32) { self.descriptor = descriptor }
    func release() {
        lock.withLock {
            guard let descriptor else { return }
            self.descriptor = nil
            _ = flock(descriptor, LOCK_UN)
            close(descriptor)
        }
    }
    deinit { release() }
}
