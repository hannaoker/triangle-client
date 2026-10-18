import Foundation
import TriangleMailboxCore

struct CredentialCustodyPolicyContractFailure: Error, CustomStringConvertible {
    let description: String
    init(_ description: String) { self.description = description }
}

public enum CredentialCustodyPolicyContractCases {
    public struct ContractCase: Sendable {
        public let name: String
        public let run: @Sendable () throws -> Void
    }

    public static var all: [ContractCase] {
        [
            .init(name: "public ad-hoc release always selects file custody", run: publicReleaseSelectsFileCustody),
            .init(name: "public ad-hoc release rejects Keychain custody clearly", run: publicReleaseRejectsKeychain),
            .init(name: "local ad-hoc keeps Keychain default and file opt-in", run: localAdHocCompatibility),
            .init(name: "non-ad-hoc build never selects file custody implicitly", run: keychainOnlyBuild),
            .init(name: "unknown custody values are rejected", run: unknownCustodyRejected),
        ]
    }

    public static func publicReleaseSelectsFileCustody() throws {
        for requested in [nil, "", "file", " FILE "] as [String?] {
            for optIn in [false, true] {
                let mode = try CredentialCustodyPolicy.resolve(
                    requested: requested, fileOptIn: optIn, requireFile: true, allowFileOptIn: false
                )
                try expect(mode == .file, "required-file build selected \(mode) for \(requested ?? "nil")")
            }
        }
    }

    public static func publicReleaseRejectsKeychain() throws {
        do {
            _ = try CredentialCustodyPolicy.resolve(
                requested: "keychain", fileOptIn: true, requireFile: true, allowFileOptIn: true
            )
            throw CredentialCustodyPolicyContractFailure("required-file build accepted Keychain custody")
        } catch let error as CredentialCustodyPolicyError {
            try expect(error == .keychainUnavailableInAdHocRelease, "unexpected error \(error)")
            try expect(error.description.contains("keychain-access-groups"), "message omits the entitlement reason")
            try expect(error.description.contains("credentials/local"), "message omits the file custody location")
            try expect(error.description.contains("TRIANGLE_CREDENTIAL_CUSTODY"), "message omits the fix")
        }
    }

    public static func localAdHocCompatibility() throws {
        try expect(
            try CredentialCustodyPolicy.resolve(requested: nil, fileOptIn: false, requireFile: false, allowFileOptIn: true) == .keychain,
            "local ad-hoc default must stay on the Keychain compatibility path"
        )
        try expect(
            try CredentialCustodyPolicy.resolve(requested: nil, fileOptIn: true, requireFile: false, allowFileOptIn: true) == .file,
            "local ad-hoc ENABLED marker / TRIANGLE_FILE_CREDENTIALS=1 must select file custody"
        )
        try expect(
            try CredentialCustodyPolicy.resolve(requested: "file", fileOptIn: false, requireFile: false, allowFileOptIn: true) == .file,
            "local ad-hoc explicit file request must select file custody"
        )
        try expect(
            try CredentialCustodyPolicy.resolve(requested: "keychain", fileOptIn: true, requireFile: false, allowFileOptIn: true) == .keychain,
            "local ad-hoc explicit keychain request must select Keychain"
        )
    }

    public static func keychainOnlyBuild() throws {
        for requested in [nil, "file"] as [String?] {
            let mode = try CredentialCustodyPolicy.resolve(
                requested: requested, fileOptIn: true, requireFile: false, allowFileOptIn: false
            )
            try expect(mode == .keychain, "build without file custody flags selected \(mode)")
        }
    }

    public static func unknownCustodyRejected() throws {
        for requireFile in [false, true] {
            do {
                _ = try CredentialCustodyPolicy.resolve(
                    requested: "keyring", fileOptIn: false, requireFile: requireFile, allowFileOptIn: true
                )
                throw CredentialCustodyPolicyContractFailure("unknown custody accepted")
            } catch let error as CredentialCustodyPolicyError {
                try expect(error == .unknownCustody, "unexpected error \(error)")
            }
        }
        let message = CredentialCustodyPolicy.launchFailure(environment: ["TRIANGLE_CREDENTIAL_CUSTODY": "keyring"])
        try expect(message?.contains("TRIANGLE_CREDENTIAL_CUSTODY") == true, "launch failure omitted the variable name")
        try expect(CredentialCustodyPolicy.launchFailure(environment: [:]) == nil, "empty environment must pass launch policy")
    }

    private static func expect(_ condition: @autoclosure () throws -> Bool, _ message: String) throws {
        guard try condition() else { throw CredentialCustodyPolicyContractFailure(message) }
    }
}
