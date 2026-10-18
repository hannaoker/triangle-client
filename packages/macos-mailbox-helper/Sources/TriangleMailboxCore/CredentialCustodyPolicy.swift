import Foundation
#if canImport(Darwin)
import Darwin
#endif

/// Which backend holds mailbox, workload, and watch-grant credentials.
public enum CredentialCustodyMode: String, Sendable, Equatable {
    /// Portable `0600` files under `credentials/local` (see `LocalCredentialStores`).
    case file
    /// Data Protection Keychain (watch grants on `--local-ad-hoc` development installs).
    case keychain
}

public enum CredentialCustodyPolicyError: Error, Equatable, Sendable, CustomStringConvertible {
    /// Keychain custody was requested from a public ad-hoc release build.
    case keychainUnavailableInAdHocRelease
    /// `TRIANGLE_CREDENTIAL_CUSTODY` held something other than `file` or `keychain`.
    case unknownCustody

    public var description: String {
        switch self {
        case .keychainUnavailableInAdHocRelease:
            return "Keychain credential custody is unavailable in this public ad-hoc release build: "
                + "ad-hoc signatures cannot carry the keychain-access-groups entitlement, so the helper "
                + "keeps watch grants in 0600 files under ~/Library/Application Support/The Triangle/credentials/local. "
                + "Unset TRIANGLE_CREDENTIAL_CUSTODY (or set it to file). Agent identities are never Keychain "
                + "custody: profiles point at triangle workload key files."
        case .unknownCustody:
            return "TRIANGLE_CREDENTIAL_CUSTODY must be unset, file, or keychain"
        }
    }
}

/// Pure selection of the credential custody backend.
///
/// Build flags (set by `scripts/install-macos-mailbox-helper.sh`):
/// - `TRIANGLE_FILE_CUSTODY_REQUIRED`: public ad-hoc release. File custody is the only
///   backend; an explicit Keychain request is a launch-time error, never a silent fallback.
/// - `TRIANGLE_LOCAL_AD_HOC`: local development. Keychain (with the legacy-Keychain
///   fallback) unless file custody is opted in via `TRIANGLE_FILE_CREDENTIALS=1` or the
///   `credentials/local/ENABLED` marker.
/// - neither: Keychain only.
public enum CredentialCustodyPolicy {
    public static let environmentKey = "TRIANGLE_CREDENTIAL_CUSTODY"

    public static var buildRequiresFileCustody: Bool {
        #if TRIANGLE_FILE_CUSTODY_REQUIRED
        return true
        #else
        return false
        #endif
    }

    public static var buildAllowsFileOptIn: Bool {
        #if TRIANGLE_LOCAL_AD_HOC
        return true
        #else
        return false
        #endif
    }

    public static func resolve(
        requested: String?,
        fileOptIn: Bool,
        requireFile: Bool,
        allowFileOptIn: Bool
    ) throws -> CredentialCustodyMode {
        let normalized = requested?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
        let explicit: CredentialCustodyMode?
        switch normalized {
        case "": explicit = nil
        case "file": explicit = .file
        case "keychain": explicit = .keychain
        default: throw CredentialCustodyPolicyError.unknownCustody
        }
        if requireFile {
            if explicit == .keychain { throw CredentialCustodyPolicyError.keychainUnavailableInAdHocRelease }
            return .file
        }
        if explicit == .keychain { return .keychain }
        if allowFileOptIn && (explicit == .file || fileOptIn) { return .file }
        return .keychain
    }

    /// Custody for this process. A policy error resolves to `.file` here so that a
    /// required-file build can never reach Keychain; `enforceAtLaunch` reports it.
    public static func current(fileOptIn: @autoclosure () -> Bool) -> CredentialCustodyMode {
        do {
            return try resolve(
                requested: ProcessInfo.processInfo.environment[environmentKey],
                fileOptIn: fileOptIn(),
                requireFile: buildRequiresFileCustody,
                allowFileOptIn: buildAllowsFileOptIn
            )
        } catch {
            return buildRequiresFileCustody ? .file : .keychain
        }
    }

    /// Validates the requested custody before any credential operation. Returns the
    /// operator-facing failure message, or nil when the request is acceptable.
    public static func launchFailure(environment: [String: String] = ProcessInfo.processInfo.environment) -> String? {
        do {
            _ = try resolve(
                requested: environment[environmentKey],
                fileOptIn: false,
                requireFile: buildRequiresFileCustody,
                allowFileOptIn: buildAllowsFileOptIn
            )
            return nil
        } catch let error as CredentialCustodyPolicyError {
            return error.description
        } catch {
            return "credential custody policy failed"
        }
    }

    /// Exits with EX_CONFIG (78) and a clear message when the requested custody is invalid.
    public static func enforceAtLaunch() {
        guard let message = launchFailure() else { return }
        FileHandle.standardError.write(Data("triangle: \(message)\n".utf8))
        exit(78)
    }
}
