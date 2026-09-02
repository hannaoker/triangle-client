import CryptoKit
import Foundation

public enum Base64URL {
    public static func encode(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    public static func decode(_ string: String) -> Data? {
        var base64 = string
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        let padLength = (4 - (base64.count % 4)) % 4
        base64.append(contentsOf: String(repeating: "=", count: padLength))
        return Data(base64Encoded: base64)
    }
}

public struct WorkloadPublicJWK: Codable, Equatable, Sendable {
    public let crv: String
    public let kty: String
    public let x: String

    public init(x: String) throws {
        guard x.wholeMatch(of: /^[A-Za-z0-9_-]{43}$/) != nil else {
            throw ModelValidationError.invalidPublicJWK
        }
        self.crv = "Ed25519"
        self.kty = "OKP"
        self.x = x
    }

    public init(publicKey: Curve25519.Signing.PublicKey) {
        self.crv = "Ed25519"
        self.kty = "OKP"
        self.x = Base64URL.encode(publicKey.rawRepresentation)
    }

    public var canonicalJSONString: String {
        "{\"crv\":\"Ed25519\",\"kty\":\"OKP\",\"x\":\"\(x)\"}"
    }

    public var jkt: String {
        let digest = SHA256.hash(data: Data(canonicalJSONString.utf8))
        return Base64URL.encode(Data(digest))
    }
}

public struct WorkloadID: Codable, Equatable, Hashable, Sendable {
    public let value: String

    public init(_ value: String) throws {
        guard value.wholeMatch(of: /^workload_[a-f0-9]{32}$/) != nil else {
            throw ModelValidationError.invalidWorkloadID
        }
        self.value = value
    }

    public static func generate() -> Self {
        var bytes = [UInt8](repeating: 0, count: 16)
        _ = SecRandomCopyBytes(kSecRandomDefault, 16, &bytes)
        let hex = bytes.map { String(format: "%02x", $0) }.joined()
        return try! Self("workload_\(hex)")
    }
}

public enum RFC8785CanonicalJSON {
    public static func escapeString(_ string: String) -> String {
        var output = "\""
        for scalar in string.unicodeScalars {
            switch scalar.value {
            case 0x22: output.append("\\\"")
            case 0x5C: output.append("\\\\")
            case 0x08: output.append("\\b")
            case 0x0C: output.append("\\f")
            case 0x0A: output.append("\\n")
            case 0x0D: output.append("\\r")
            case 0x09: output.append("\\t")
            case 0x00...0x1F:
                output.append(String(format: "\\u%04x", scalar.value))
            default:
                output.append(String(scalar))
            }
        }
        output.append("\"")
        return output
    }

    public static func canonicalRegistrationProof(
        challengeID: String,
        expiresAt: String,
        nonceSHA256: String,
        origin: String,
        proofProfile: String,
        capabilities: [String],
        description: String,
        handle: String,
        identityProfile: String,
        name: String,
        workloadID: String,
        workloadJKT: String,
        workloadPublicJWK: WorkloadPublicJWK
    ) -> Data {
        let sortedCapabilities = capabilities.sorted()
        let capabilitiesJSON = "[" + sortedCapabilities.map { escapeString($0) }.joined(separator: ",") + "]"
        let registrationJSON = "{" + [
            "\"capabilities\":" + capabilitiesJSON,
            "\"description\":" + escapeString(description),
            "\"handle\":" + escapeString(handle),
            "\"identity_profile\":" + escapeString(identityProfile),
            "\"name\":" + escapeString(name),
            "\"workload_id\":" + escapeString(workloadID),
            "\"workload_jkt\":" + escapeString(workloadJKT),
            "\"workload_public_jwk\":" + workloadPublicJWK.canonicalJSONString
        ].joined(separator: ",") + "}"

        let envelopeJSON = "{" + [
            "\"challenge_id\":" + escapeString(challengeID),
            "\"expires_at\":" + escapeString(expiresAt),
            "\"nonce_sha256\":" + escapeString(nonceSHA256),
            "\"origin\":" + escapeString(origin),
            "\"proof_profile\":" + escapeString(proofProfile),
            "\"registration\":" + registrationJSON
        ].joined(separator: ",") + "}"

        return Data(envelopeJSON.utf8)
    }
}
