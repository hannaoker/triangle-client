import Darwin
import Foundation

public enum MailboxTransactionStoreError: Error, Equatable, Sendable {
    case notFound
    case alreadyOpen
    case unsafeStorage
    case invalidRecord
    case invalidTransition
    case protocolMismatch
    case nestedClaim
    case unrelatedAcknowledgement
    case transactionStuck
}

@_spi(MailboxTransactionTesting)
public enum MailboxTransactionStoreCrashPoint: Equatable, Sendable {
    case beforeLocalPrepare
    case afterTemporaryFsync
    case afterExclusiveRename
    case afterLocalPrepare
    case afterServerClaim
    case beforeLocalReplyWrite
    case afterReplyCommit
    case beforeAck
    case afterAck
}

public protocol MailboxTransactionStore: Sendable {
    func readOpen(instanceID: ClientInstanceID) throws -> MailboxOpenTransaction?
    func prepare(_ transaction: MailboxOpenTransaction) throws
    func replace(_ transaction: MailboxOpenTransaction) throws
    func clear(instanceID: ClientInstanceID, expectedDeliveryID: Int?) throws
    func abandon(instanceID: ClientInstanceID) throws -> MailboxQuarantinedTransaction
    func listQuarantined(instanceID: ClientInstanceID) throws -> [MailboxQuarantinedTransaction]
}

public final class InMemoryMailboxTransactionStore: MailboxTransactionStore, @unchecked Sendable {
    private let lock = NSLock()
    private var open: [ClientInstanceID: MailboxOpenTransaction] = [:]
    private var quarantine: [ClientInstanceID: [MailboxQuarantinedTransaction]] = [:]

    public init() {}

    public func readOpen(instanceID: ClientInstanceID) throws -> MailboxOpenTransaction? {
        lock.withLock { open[instanceID] }
    }

    public func prepare(_ transaction: MailboxOpenTransaction) throws {
        try lock.withLock {
            if open[transaction.instanceID] != nil { throw MailboxTransactionStoreError.alreadyOpen }
            open[transaction.instanceID] = transaction
        }
    }

    public func replace(_ transaction: MailboxOpenTransaction) throws {
        try lock.withLock {
            guard let current = open[transaction.instanceID] else { throw MailboxTransactionStoreError.notFound }
            guard current.deliveryID == transaction.deliveryID,
                  current.protocolOwnership == transaction.protocolOwnership,
                  current.claimID == transaction.claimID,
                  current.replyIdempotencyKey == transaction.replyIdempotencyKey,
                  current.createdAt == transaction.createdAt
            else { throw MailboxTransactionStoreError.invalidRecord }
            open[transaction.instanceID] = transaction
        }
    }

    public func clear(instanceID: ClientInstanceID, expectedDeliveryID: Int?) throws {
        try lock.withLock {
            guard let current = open[instanceID] else { throw MailboxTransactionStoreError.notFound }
            if let expectedDeliveryID, current.deliveryID != expectedDeliveryID {
                throw MailboxTransactionStoreError.unrelatedAcknowledgement
            }
            open.removeValue(forKey: instanceID)
        }
    }

    public func abandon(instanceID: ClientInstanceID) throws -> MailboxQuarantinedTransaction {
        try lock.withLock {
            guard let current = open.removeValue(forKey: instanceID) else {
                throw MailboxTransactionStoreError.notFound
            }
            let entry = MailboxQuarantinedTransaction(
                deliveryID: current.deliveryID,
                protocolOwnership: current.protocolOwnership,
                correlationID: "q_" + String(MailboxTransactionIdentifier.claimId(instanceID: instanceID, deliveryID: current.deliveryID).dropFirst(6).prefix(16)),
                quarantinedAt: MailboxTransactionTimestamp.now()
            )
            quarantine[instanceID, default: []].append(entry)
            return entry
        }
    }

    public func listQuarantined(instanceID: ClientInstanceID) throws -> [MailboxQuarantinedTransaction] {
        lock.withLock { quarantine[instanceID] ?? [] }
    }
}

/// Durable `INSTANCE_ROOT/mailbox-transactions/open.json` store.
///
/// Path: `~/Library/Application Support/The Triangle/model-state/instances/<id>/mailbox-transactions/`
public final class FileMailboxTransactionStore: MailboxTransactionStore, @unchecked Sendable {
    private static let maximumBytes = 4096
    private static let inProcessLock = NSLock()
    private let root: URL
    private let managedDirectories: [URL]
    private let simulatedCrashAt: MailboxTransactionStoreCrashPoint?

    public convenience init(instanceID: ClientInstanceID) {
        let applicationRoot = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/The Triangle", isDirectory: true)
        let modelState = applicationRoot.appendingPathComponent("model-state", isDirectory: true)
        let instances = modelState.appendingPathComponent("instances", isDirectory: true)
        let instanceRoot = instances.appendingPathComponent(instanceID.value, isDirectory: true)
        let transactions = instanceRoot.appendingPathComponent("mailbox-transactions", isDirectory: true)
        self.init(
            root: transactions,
            managedDirectories: [applicationRoot, modelState, instances, instanceRoot, transactions],
            simulatedCrashAt: nil
        )
    }

    private init(
        root: URL,
        managedDirectories: [URL],
        simulatedCrashAt: MailboxTransactionStoreCrashPoint?
    ) {
        self.root = root
        self.managedDirectories = managedDirectories
        self.simulatedCrashAt = simulatedCrashAt
    }

    @_spi(MailboxTransactionTesting)
    public convenience init(
        testRoot: URL,
        simulatedCrashAt: MailboxTransactionStoreCrashPoint? = nil
    ) {
        let quarantine = testRoot.appendingPathComponent("quarantine", isDirectory: true)
        self.init(
            root: testRoot,
            managedDirectories: [testRoot, quarantine],
            simulatedCrashAt: simulatedCrashAt
        )
    }

    @_spi(MailboxTransactionTesting)
    public static func metadataIsSafe(mode: Int, owner: Int, linkCount: Int, directory: Bool) -> Bool {
        guard owner == Int(getuid()) else { return false }
        if directory { return mode == 0o700 && linkCount >= 1 }
        return mode == 0o600 && linkCount == 1
    }

    public func readOpen(instanceID: ClientInstanceID) throws -> MailboxOpenTransaction? {
        try withDirectoryLock(exclusive: false) { directory in
            do {
                let record = try readOpenFile(directory: directory)
                guard record.instanceID == instanceID else { throw MailboxTransactionStoreError.invalidRecord }
                return record
            } catch MailboxTransactionStoreError.notFound {
                return nil
            }
        }
    }

    public func prepare(_ transaction: MailboxOpenTransaction) throws {
        if simulatedCrashAt == .beforeLocalPrepare {
            throw MailboxTransactionStoreError.unsafeStorage
        }
        let data = try encode(transaction)
        try withDirectoryLock(exclusive: true) { directory in
            do {
                _ = try readOpenFile(directory: directory)
                throw MailboxTransactionStoreError.alreadyOpen
            } catch MailboxTransactionStoreError.notFound {
                try write(data, directory: directory, name: "open.json", replace: false)
            }
        }
        if simulatedCrashAt == .afterLocalPrepare {
            throw MailboxTransactionStoreError.unsafeStorage
        }
    }

    public func replace(_ transaction: MailboxOpenTransaction) throws {
        let data = try encode(transaction)
        try withDirectoryLock(exclusive: true) { directory in
            let current = try readOpenFile(directory: directory)
            guard current.instanceID == transaction.instanceID,
                  current.deliveryID == transaction.deliveryID,
                  current.protocolOwnership == transaction.protocolOwnership,
                  current.claimID == transaction.claimID,
                  current.replyIdempotencyKey == transaction.replyIdempotencyKey,
                  current.createdAt == transaction.createdAt
            else { throw MailboxTransactionStoreError.invalidRecord }
            try write(data, directory: directory, name: "open.json", replace: true)
        }
    }

    public func clear(instanceID: ClientInstanceID, expectedDeliveryID: Int?) throws {
        try withDirectoryLock(exclusive: true) { directory in
            let current = try readOpenFile(directory: directory)
            guard current.instanceID == instanceID else { throw MailboxTransactionStoreError.invalidRecord }
            if let expectedDeliveryID, current.deliveryID != expectedDeliveryID {
                throw MailboxTransactionStoreError.unrelatedAcknowledgement
            }
            guard unlinkat(directory, "open.json", 0) == 0, fsync(directory) == 0 else {
                throw MailboxTransactionStoreError.unsafeStorage
            }
        }
    }

    public func abandon(instanceID: ClientInstanceID) throws -> MailboxQuarantinedTransaction {
        try withDirectoryLock(exclusive: true) { directory in
            let current = try readOpenFile(directory: directory)
            guard current.instanceID == instanceID else { throw MailboxTransactionStoreError.invalidRecord }
            let quarantineDir = try openQuarantine(directory: directory, create: true)
            defer { close(quarantineDir) }
            let correlation = "q_" + String(current.claimID.value.dropFirst(6).prefix(16))
            let name = "\(correlation).json"
            let payload: [String: Any] = [
                "version": 1,
                "deliveryId": current.deliveryID,
                "protocol": current.protocolOwnership.rawValue,
                "correlationId": correlation,
                "quarantinedAt": MailboxTransactionTimestamp.now(),
                // Explicit: pre-lease abandonment does not release the MESH claim.
                "serverClaimReleased": false,
            ]
            let data = try JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
            try writeRaw(data, directory: quarantineDir, name: name, replace: false)
            guard unlinkat(directory, "open.json", 0) == 0, fsync(directory) == 0 else {
                throw MailboxTransactionStoreError.unsafeStorage
            }
            return MailboxQuarantinedTransaction(
                deliveryID: current.deliveryID,
                protocolOwnership: current.protocolOwnership,
                correlationID: correlation,
                quarantinedAt: payload["quarantinedAt"] as! String
            )
        }
    }

    public func listQuarantined(instanceID: ClientInstanceID) throws -> [MailboxQuarantinedTransaction] {
        try withDirectoryLock(exclusive: false) { directory in
            var metadata = stat()
            if fstatat(directory, "quarantine", &metadata, AT_SYMLINK_NOFOLLOW) != 0 {
                if errno == ENOENT { return [] }
                throw MailboxTransactionStoreError.unsafeStorage
            }
            let quarantineDir = try openQuarantine(directory: directory, create: false)
            defer { close(quarantineDir) }
            let duplicate = dup(quarantineDir)
            guard duplicate >= 0, let stream = fdopendir(duplicate) else {
                if duplicate >= 0 { close(duplicate) }
                throw MailboxTransactionStoreError.unsafeStorage
            }
            defer { closedir(stream) }
            var entries: [MailboxQuarantinedTransaction] = []
            while let entry = readdir(stream) {
                let name = withUnsafePointer(to: &entry.pointee.d_name) {
                    $0.withMemoryRebound(to: CChar.self, capacity: Int(MAXNAMLEN) + 1) { String(cString: $0) }
                }
                if name == "." || name == ".." || name.hasPrefix(".tmp-") { continue }
                guard name.hasSuffix(".json") else { throw MailboxTransactionStoreError.invalidRecord }
                let descriptor = openat(quarantineDir, name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
                guard descriptor >= 0 else { throw MailboxTransactionStoreError.unsafeStorage }
                defer { close(descriptor) }
                try validateFile(descriptor)
                let data = try readAll(descriptor)
                guard try !StrictMailboxTransactionJSONScanner.hasDuplicateObjectMembers(data),
                      let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                      object["version"] as? Int == 1,
                      let deliveryID = object["deliveryId"] as? Int,
                      deliveryID > 0,
                      let protocolRaw = object["protocol"] as? String,
                      let protocolOwnership = MailboxTransactionProtocol(rawValue: protocolRaw),
                      let correlationID = object["correlationId"] as? String,
                      correlationID.wholeMatch(of: /^q_[a-f0-9]{16}$/) != nil,
                      let quarantinedAt = object["quarantinedAt"] as? String,
                      object["serverClaimReleased"] as? Bool == false
                else { throw MailboxTransactionStoreError.invalidRecord }
                entries.append(MailboxQuarantinedTransaction(
                    deliveryID: deliveryID,
                    protocolOwnership: protocolOwnership,
                    correlationID: correlationID,
                    quarantinedAt: quarantinedAt
                ))
            }
            return entries.sorted { $0.deliveryID < $1.deliveryID }
        }
    }

    private func withDirectoryLock<T>(exclusive: Bool, _ body: (Int32) throws -> T) throws -> T {
        Self.inProcessLock.lock()
        defer { Self.inProcessLock.unlock() }
        let directory = try openRoot()
        defer { close(directory) }
        guard flock(directory, exclusive ? LOCK_EX : LOCK_SH) == 0 else {
            throw MailboxTransactionStoreError.unsafeStorage
        }
        defer { _ = flock(directory, LOCK_UN) }
        return try body(directory)
    }

    private func openRoot() throws -> Int32 {
        for directory in managedDirectories { try ensureSafeDirectory(directory) }
        let descriptor = open(root.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard descriptor >= 0 else { throw MailboxTransactionStoreError.unsafeStorage }
        return descriptor
    }

    private func ensureSafeDirectory(_ directory: URL) throws {
        var metadata = stat()
        if lstat(directory.path, &metadata) != 0 {
            guard errno == ENOENT else { throw MailboxTransactionStoreError.unsafeStorage }
            do {
                try FileManager.default.createDirectory(
                    at: directory,
                    withIntermediateDirectories: false,
                    attributes: [.posixPermissions: 0o700]
                )
            } catch { throw MailboxTransactionStoreError.unsafeStorage }
            guard lstat(directory.path, &metadata) == 0 else { throw MailboxTransactionStoreError.unsafeStorage }
        }
        guard (metadata.st_mode & S_IFMT) == S_IFDIR,
              Self.metadataIsSafe(
                  mode: Int(metadata.st_mode & 0o777),
                  owner: Int(metadata.st_uid),
                  linkCount: Int(metadata.st_nlink),
                  directory: true
              )
        else { throw MailboxTransactionStoreError.unsafeStorage }
    }

    private func openQuarantine(directory: Int32, create: Bool) throws -> Int32 {
        let name = "quarantine"
        var metadata = stat()
        if fstatat(directory, name, &metadata, AT_SYMLINK_NOFOLLOW) != 0 {
            guard errno == ENOENT else { throw MailboxTransactionStoreError.unsafeStorage }
            guard create else { throw MailboxTransactionStoreError.notFound }
            guard mkdirat(directory, name, 0o700) == 0, fsync(directory) == 0 else {
                throw MailboxTransactionStoreError.unsafeStorage
            }
        } else {
            guard (metadata.st_mode & S_IFMT) == S_IFDIR,
                  Self.metadataIsSafe(
                      mode: Int(metadata.st_mode & 0o777),
                      owner: Int(metadata.st_uid),
                      linkCount: Int(metadata.st_nlink),
                      directory: true
                  )
            else { throw MailboxTransactionStoreError.unsafeStorage }
        }
        let descriptor = openat(directory, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard descriptor >= 0 else { throw MailboxTransactionStoreError.unsafeStorage }
        return descriptor
    }

    private func readOpenFile(directory: Int32) throws -> MailboxOpenTransaction {
        let descriptor = openat(directory, "open.json", O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
        if descriptor < 0 {
            if errno == ENOENT { throw MailboxTransactionStoreError.notFound }
            throw MailboxTransactionStoreError.unsafeStorage
        }
        defer { close(descriptor) }
        try validateFile(descriptor)
        let data = try readAll(descriptor)
        do {
            guard try !StrictMailboxTransactionJSONScanner.hasDuplicateObjectMembers(data) else {
                throw MailboxTransactionStoreError.invalidRecord
            }
            return try JSONDecoder().decode(MailboxOpenTransaction.self, from: data)
        } catch let error as MailboxTransactionStoreError {
            throw error
        } catch {
            throw MailboxTransactionStoreError.invalidRecord
        }
    }

    private func encode(_ transaction: MailboxOpenTransaction) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let data = try encoder.encode(transaction)
        guard data.count <= Self.maximumBytes else { throw MailboxTransactionStoreError.invalidRecord }
        return data
    }

    private func write(_ data: Data, directory: Int32, name: String, replace: Bool) throws {
        try writeRaw(data, directory: directory, name: name, replace: replace)
    }

    private func writeRaw(_ data: Data, directory: Int32, name: String, replace: Bool) throws {
        let temporary = ".tmp-\(UUID().uuidString.lowercased())"
        let descriptor = openat(directory, temporary, O_CREAT | O_EXCL | O_WRONLY | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard descriptor >= 0 else { throw MailboxTransactionStoreError.unsafeStorage }
        var temporaryExists = true
        var preserveTemporary = false
        defer {
            close(descriptor)
            if temporaryExists && !preserveTemporary { _ = unlinkat(directory, temporary, 0) }
        }
        guard fchmod(descriptor, 0o600) == 0 else { throw MailboxTransactionStoreError.unsafeStorage }
        try data.withUnsafeBytes { bytes in
            var offset = 0
            while offset < bytes.count {
                let count = Darwin.write(descriptor, bytes.baseAddress!.advanced(by: offset), bytes.count - offset)
                guard count > 0 else { throw MailboxTransactionStoreError.unsafeStorage }
                offset += count
            }
        }
        guard fsync(descriptor) == 0 else { throw MailboxTransactionStoreError.unsafeStorage }
        if !replace, simulatedCrashAt == .afterTemporaryFsync {
            preserveTemporary = true
            throw MailboxTransactionStoreError.unsafeStorage
        }
        if replace {
            try validateExistingRegular(directory: directory, name: name)
            guard renameat(directory, temporary, directory, name) == 0 else {
                throw MailboxTransactionStoreError.unsafeStorage
            }
            temporaryExists = false
        } else {
            guard renameatx_np(directory, temporary, directory, name, UInt32(RENAME_EXCL)) == 0 else {
                if errno == EEXIST { throw MailboxTransactionStoreError.alreadyOpen }
                throw MailboxTransactionStoreError.unsafeStorage
            }
            temporaryExists = false
            if simulatedCrashAt == .afterExclusiveRename {
                guard fsync(directory) == 0 else { throw MailboxTransactionStoreError.unsafeStorage }
                throw MailboxTransactionStoreError.unsafeStorage
            }
        }
        guard fsync(directory) == 0 else { throw MailboxTransactionStoreError.unsafeStorage }
    }

    private func validateExistingRegular(directory: Int32, name: String) throws {
        var metadata = stat()
        guard fstatat(directory, name, &metadata, AT_SYMLINK_NOFOLLOW) == 0,
              (metadata.st_mode & S_IFMT) == S_IFREG,
              Self.metadataIsSafe(
                  mode: Int(metadata.st_mode & 0o777),
                  owner: Int(metadata.st_uid),
                  linkCount: Int(metadata.st_nlink),
                  directory: false
              )
        else { throw MailboxTransactionStoreError.unsafeStorage }
    }

    private func validateFile(_ descriptor: Int32) throws {
        var metadata = stat()
        guard fstat(descriptor, &metadata) == 0,
              (metadata.st_mode & S_IFMT) == S_IFREG,
              Self.metadataIsSafe(
                  mode: Int(metadata.st_mode & 0o777),
                  owner: Int(metadata.st_uid),
                  linkCount: Int(metadata.st_nlink),
                  directory: false
              )
        else { throw MailboxTransactionStoreError.unsafeStorage }
    }

    private func readAll(_ descriptor: Int32) throws -> Data {
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 512)
        while true {
            let count = Darwin.read(descriptor, &buffer, buffer.count)
            guard count >= 0 else { throw MailboxTransactionStoreError.unsafeStorage }
            if count == 0 { break }
            data.append(buffer, count: count)
            guard data.count <= Self.maximumBytes else { throw MailboxTransactionStoreError.invalidRecord }
        }
        return data
    }
}

private enum StrictMailboxTransactionJSONError: Error { case malformed }

private struct StrictMailboxTransactionJSONScanner {
    private let bytes: [UInt8]
    private var index = 0
    private var duplicateObjectMembers = false

    static func hasDuplicateObjectMembers(_ data: Data) throws -> Bool {
        var scanner = Self(bytes: Array(data))
        scanner.skipWhitespace()
        try scanner.parseValue()
        scanner.skipWhitespace()
        guard scanner.index == scanner.bytes.count else { throw StrictMailboxTransactionJSONError.malformed }
        return scanner.duplicateObjectMembers
    }

    private mutating func parseValue() throws {
        skipWhitespace()
        guard let byte = current else { throw StrictMailboxTransactionJSONError.malformed }
        switch byte {
        case 0x7b: try parseObject()
        case 0x5b: try parseArray()
        case 0x22: _ = try parseString()
        case 0x74: try consumeLiteral("true")
        case 0x66: try consumeLiteral("false")
        case 0x6e: try consumeLiteral("null")
        case 0x2d, 0x30...0x39: try consumeNumber()
        default: throw StrictMailboxTransactionJSONError.malformed
        }
    }

    private mutating func parseObject() throws {
        try consume(0x7b)
        skipWhitespace()
        if current == 0x7d { index += 1; return }
        var keys = Set<String>()
        while true {
            guard current == 0x22 else { throw StrictMailboxTransactionJSONError.malformed }
            let key = try parseString()
            if !keys.insert(key).inserted { duplicateObjectMembers = true }
            skipWhitespace()
            try consume(0x3a)
            try parseValue()
            skipWhitespace()
            if current == 0x7d { index += 1; return }
            try consume(0x2c)
            skipWhitespace()
        }
    }

    private mutating func parseArray() throws {
        try consume(0x5b)
        skipWhitespace()
        if current == 0x5d { index += 1; return }
        while true {
            try parseValue()
            skipWhitespace()
            if current == 0x5d { index += 1; return }
            try consume(0x2c)
            skipWhitespace()
        }
    }

    private mutating func parseString() throws -> String {
        try consume(0x22)
        var result = ""
        while let byte = current {
            if byte == 0x22 { index += 1; return result }
            guard byte >= 0x20 else { throw StrictMailboxTransactionJSONError.malformed }
            if byte == 0x5c {
                index += 1
                guard let escaped = current else { throw StrictMailboxTransactionJSONError.malformed }
                index += 1
                switch escaped {
                case 0x22: result.append("\"")
                case 0x5c: result.append("\\")
                case 0x2f: result.append("/")
                case 0x62: result.append("\u{8}")
                case 0x66: result.append("\u{c}")
                case 0x6e: result.append("\n")
                case 0x72: result.append("\r")
                case 0x74: result.append("\t")
                case 0x75:
                    var hex = ""
                    for _ in 0..<4 {
                        guard let h = current, CharacterSet(charactersIn: "0123456789abcdefABCDEF").contains(UnicodeScalar(h)) else {
                            throw StrictMailboxTransactionJSONError.malformed
                        }
                        hex.append(Character(UnicodeScalar(h)))
                        index += 1
                    }
                    guard let value = UInt32(hex, radix: 16), let scalar = UnicodeScalar(value) else {
                        throw StrictMailboxTransactionJSONError.malformed
                    }
                    result.append(Character(scalar))
                default: throw StrictMailboxTransactionJSONError.malformed
                }
                continue
            }
            result.append(Character(UnicodeScalar(byte)))
            index += 1
        }
        throw StrictMailboxTransactionJSONError.malformed
    }

    private mutating func consumeNumber() throws {
        if current == 0x2d { index += 1 }
        guard let first = current, (0x30...0x39).contains(first) else { throw StrictMailboxTransactionJSONError.malformed }
        if first == 0x30 {
            index += 1
        } else {
            while let byte = current, (0x30...0x39).contains(byte) { index += 1 }
        }
        if current == 0x2e {
            index += 1
            guard let byte = current, (0x30...0x39).contains(byte) else { throw StrictMailboxTransactionJSONError.malformed }
            while let byte = current, (0x30...0x39).contains(byte) { index += 1 }
        }
        if current == 0x65 || current == 0x45 {
            index += 1
            if current == 0x2b || current == 0x2d { index += 1 }
            guard let byte = current, (0x30...0x39).contains(byte) else { throw StrictMailboxTransactionJSONError.malformed }
            while let byte = current, (0x30...0x39).contains(byte) { index += 1 }
        }
    }

    private mutating func consumeLiteral(_ literal: String) throws {
        for byte in literal.utf8 {
            try consume(byte)
        }
    }

    private mutating func consume(_ byte: UInt8) throws {
        guard current == byte else { throw StrictMailboxTransactionJSONError.malformed }
        index += 1
    }

    private mutating func skipWhitespace() {
        while let byte = current, byte == 0x20 || byte == 0x09 || byte == 0x0a || byte == 0x0d {
            index += 1
        }
    }

    private var current: UInt8? {
        guard index < bytes.count else { return nil }
        return bytes[index]
    }
}
