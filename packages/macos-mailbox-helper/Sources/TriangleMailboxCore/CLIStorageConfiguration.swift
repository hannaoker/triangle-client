import Darwin
import Foundation

/// A CLI home owns credentials AND their journal/locks/transactions. Never redirect
/// just the locks while continuing to use another home's credential namespace.
public struct CLIStorageConfiguration: Sendable {
    public let applicationRoot: URL
    public let standalone: Bool
    public let arguments: [String]

    public static var desktopRoot: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/The Triangle", isDirectory: true)
    }

    public init(arguments: [String], environment: [String: String] = ProcessInfo.processInfo.environment,
                userHome: URL = FileManager.default.homeDirectoryForCurrentUser,
                desktopExists: Bool? = nil) throws {
        var remaining: [String] = []
        var explicitHome: String?
        var index = 0
        while index < arguments.count {
            let argument = arguments[index]
            if argument == "--home" || argument.hasPrefix("--home=") {
                guard explicitHome == nil else { throw CLIStorageError.invalidHome }
                if argument == "--home" {
                    index += 1
                    guard index < arguments.count else { throw CLIStorageError.invalidHome }
                    explicitHome = arguments[index]
                } else {
                    explicitHome = String(argument.dropFirst("--home=".count))
                }
            } else { remaining.append(argument) }
            index += 1
        }
        self.arguments = remaining
        let desktop = userHome.appendingPathComponent("Library/Application Support/The Triangle", isDirectory: true)
        if let selected = explicitHome ?? environment["TRIANGLE_HOME"] {
            applicationRoot = try Self.absoluteDirectory(selected)
            // Explicitly selecting the desktop directory must retain its custody policy.
            standalone = applicationRoot.resolvingSymlinksInPath().path != desktop.resolvingSymlinksInPath().path
        } else if try desktopExists ?? Self.desktopHomeExists(desktop) {
            applicationRoot = desktop
            standalone = false
        } else {
            let base: URL
            if let xdg = environment["XDG_STATE_HOME"], !xdg.isEmpty {
                base = try Self.absoluteDirectory(xdg)
            } else { base = userHome.appendingPathComponent(".local/state", isDirectory: true) }
            applicationRoot = base.appendingPathComponent("triangle", isDirectory: true)
            standalone = true
        }
    }

    private static func desktopHomeExists(_ directory: URL) throws -> Bool {
        var metadata = stat()
        if lstat(directory.path, &metadata) == 0 { return true }
        let code = errno
        if code == ENOENT { return false }
        try CLIStorageError.checkAccess("inspect desktop home", code: code)
        // An inaccessible/broken desktop home is not a fresh installation.
        throw CLIStorageError.invalidHome
    }

    private static func absoluteDirectory(_ value: String) throws -> URL {
        guard value.hasPrefix("/"), !value.utf8.contains(0), value != "/" else {
            throw CLIStorageError.invalidHome
        }
        let url = URL(fileURLWithPath: value, isDirectory: true).standardizedFileURL
        guard url.path != "/" else { throw CLIStorageError.invalidHome }
        return url
    }

    public func validate(command: HelperCommand) throws {
        guard standalone else { return }
        switch command {
        case .enroll, .status, .mcp,
             .transactionPreflight, .transactionStatus, .transactionClaim, .transactionClaimNext,
             .transactionDrainReceipts, .transactionReadInbound, .transactionReply, .transactionAck,
             .transactionAbandon, .transactionRecordFailure:
            return
        default: throw CLIStorageError.desktopCommandRequiresDesktopHome
        }
    }

    public var credentialsRoot: URL { applicationRoot.appendingPathComponent("credentials/local", isDirectory: true) }

    public func mailbox() -> any CredentialStore {
        standalone ? FileCredentialStore(root: credentialsRoot, managedRoot: applicationRoot) : LocalCredentialStores.mailbox()
    }

    public func workload() -> any WorkloadKeyStore {
        standalone ? FileWorkloadKeyStore(root: credentialsRoot, managedRoot: applicationRoot) : LocalCredentialStores.workload()
    }

    public func reservation() -> FileEnrollmentReservation { FileEnrollmentReservation(applicationRoot: applicationRoot) }
    public func journal() -> FileEnrollmentJournal { FileEnrollmentJournal(applicationRoot: applicationRoot) }

    public var diagnostic: [String: String] {
        ["home": applicationRoot.path, "mode": standalone ? "standalone" : "desktop",
         "credentialStore": standalone ? "file" : (LocalCredentialStores.fileCredentialsEnabled ? "file" : "keychain")]
    }
}

public enum CLIStorageError: Error, Equatable, Sendable, CustomStringConvertible {
    case invalidHome
    case desktopCommandRequiresDesktopHome
    case accessDenied(operation: String, code: Int32)

    public var code: String {
        switch self {
        case .invalidHome: "invalid_cli_home"
        case .desktopCommandRequiresDesktopHome: "desktop_command_requires_desktop_home"
        case .accessDenied: "state_access_denied"
        }
    }

    public var description: String {
        switch self {
        case .invalidHome:
            "--home / TRIANGLE_HOME must be a non-root absolute directory path. Supply --home only once."
        case .desktopCommandRequiresDesktopHome:
            "Supervisor and watch commands use the installed desktop home. Standalone homes support enroll, status, mcp and transaction commands."
        case let .accessDenied(operation, code):
            "Cannot \(operation) (errno \(code)). The CLI needs a writable home. Check directory/sandbox access or select --home / TRIANGLE_HOME. A different home has separate profiles; do not re-enroll an existing identity to fix access."
        }
    }

    static func checkAccess(_ operation: String, code: Int32 = errno) throws {
        if code == EACCES || code == EPERM || code == EROFS {
            throw CLIStorageError.accessDenied(operation: operation, code: code)
        }
    }
}
