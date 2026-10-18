import Foundation

// Permissions v1: helper profiles are bound to agents the owner created with
// `triangle agent add` (or at `triangle join`). There is no self-registration,
// admission token, or permanent `mesh_` bearer anywhere in the helper.

public enum CredentialReplacementConfirmation: Equatable, Sendable {
    case confirmed
    case notConfirmed
}

public enum ProfileVerificationStatus: String, Codable, CaseIterable, Equatable, Sendable {
    case verified
    case offlineUnverified = "offline_unverified"
    case profileNotFound = "profile_not_found"
    case credentialInvalid = "credential_invalid"
    case credentialRefused = "credential_refused"
    case agentPaused = "agent_paused"
    case identityMismatch = "identity_mismatch"
    case verificationFailed = "verification_failed"
}

public enum ProfileOperatorAction: String, Codable, Equatable, Sendable {
    case none
    case retryVerification = "retry_verification"
    case bindProfile = "bind_profile"
    case reviewInstalledProfile = "review_installed_profile"
    case resumeAgent = "resume_agent"
    case runTriangleDoctor = "run_triangle_doctor"
}

/// The secret-free result of `bind` / `status`.
public struct ProfileStatus: Codable, Equatable, Sendable {
    public let profile: String
    public let origin: String?
    public let agentID: String?
    public let handle: String?
    public let status: ProfileVerificationStatus
    public let operatorAction: ProfileOperatorAction
    /// The agent's current permission toggles from `GET /agents/me` (verified only).
    public let permissions: [String: Bool]?
    public let permissionsRevision: Int?

    public init(
        profile: ProfileName, material: V1AgentMaterial?, status: ProfileVerificationStatus,
        permissions: [String: Bool]? = nil, permissionsRevision: Int? = nil
    ) {
        self.profile = profile.value
        origin = material?.origin.value
        agentID = material?.agentID.value
        handle = material?.handle.value
        self.status = status
        operatorAction = switch status {
        case .verified: .none
        case .offlineUnverified, .verificationFailed: .retryVerification
        case .profileNotFound: .bindProfile
        case .credentialInvalid, .credentialRefused: .runTriangleDoctor
        case .agentPaused: .resumeAgent
        case .identityMismatch: .reviewInstalledProfile
        }
        self.permissions = permissions
        self.permissionsRevision = permissionsRevision
    }

    private enum CodingKeys: String, CodingKey {
        case profile, origin, handle, status, operatorAction, permissions, permissionsRevision
        case agentID = "agentId"
    }

    public static func failure(profile: ProfileName, material: V1AgentMaterial?, error: VerifiedCredentialGateError) -> ProfileStatus {
        let status: ProfileVerificationStatus = switch error {
        case .profileNotFound: .profileNotFound
        case .credentialInvalid: .credentialInvalid
        case .credentialRefused: .credentialRefused
        case .agentPaused: .agentPaused
        case .offline: .offlineUnverified
        case .identityMismatch: .identityMismatch
        case .verificationFailed: .verificationFailed
        }
        return ProfileStatus(profile: profile, material: material, status: status)
    }
}

public enum EnrollmentError: Error, Equatable, Sendable, CustomStringConvertible, CustomDebugStringConvertible {
    case invalidInput

    public var description: String { "invalid input" }
    public var debugDescription: String { description }
}

public enum VerifiedCredentialGateError: Error, Equatable, Sendable {
    /// No helper profile binding (run `triangle-mailbox bind`).
    case profileNotFound
    /// The bound key file or its agent.json is missing, unsafe, or malformed.
    case credentialInvalid
    /// MESH refused this workload (invalid proof, forbidden, or revoked).
    case credentialRefused
    /// The owner paused this agent.
    case agentPaused
    case offline
    case identityMismatch
    case verificationFailed
}

/// A verified, secret-redacting view of one bound agent.
public struct VerifiedCredential: Sendable, CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
    public let material: V1AgentMaterial
    public let permissions: [String: Bool]?
    public let permissionsRevision: Int?
    /// The token manager that proved this identity; reuse it so a session
    /// does not exchange a second workload token.
    private let verifiedAuth: WorkloadTokenManager?

    public var origin: MeshOrigin { material.origin }
    public var agentID: AgentID { material.agentID }
    public var handle: MailboxHandle { material.handle }
    public var workloadID: WorkloadID { material.workloadID }
    public var workloadKeyFile: URL { material.keyFile }
    public var workloadRecord: WorkloadKeyRecord { material.workloadRecord }

    public init(
        material: V1AgentMaterial, permissions: [String: Bool]? = nil, permissionsRevision: Int? = nil,
        auth: WorkloadTokenManager? = nil
    ) {
        self.material = material
        self.permissions = permissions
        self.permissionsRevision = permissionsRevision
        verifiedAuth = auth
    }

    /// Workload auth for MESH calls as this agent (the verifying manager when available).
    public func workloadAuth(transport: any MeshTransport) throws -> WorkloadTokenManager {
        if let verifiedAuth { return verifiedAuth }
        return try WorkloadTokenManager(origin: origin, workloadRecord: workloadRecord, transport: transport)
    }

    public var description: String { "VerifiedCredential(origin: \(origin.value), agentID: \(agentID.value), handle: \(handle.value), key: <redacted>)" }
    public var debugDescription: String { description }
    public var customMirror: Mirror { Mirror(self, children: ["origin": origin.value, "agentID": agentID.value, "handle": handle.value, "key": "<redacted>"], displayStyle: .struct) }
}

/// Resolves a profile to its v1 agent and proves it with `GET /api/v1/agents/me`
/// over a workload access token + DPoP before any caller may use it.
public struct VerifiedCredentialGate: Sendable {
    private let resolver: any V1AgentResolver
    private let transport: any MeshTransport

    public init(resolver: any V1AgentResolver, transport: any MeshTransport) {
        self.resolver = resolver
        self.transport = transport
    }

    public func material(for profile: ProfileName) throws -> V1AgentMaterial {
        do {
            return try resolver.material(for: profile)
        } catch V1CustodyError.profileNotBound {
            throw VerifiedCredentialGateError.profileNotFound
        } catch {
            throw VerifiedCredentialGateError.credentialInvalid
        }
    }

    public func credential(for profile: ProfileName) async throws -> VerifiedCredential {
        let material = try material(for: profile)
        let manager: WorkloadTokenManager
        do {
            manager = try WorkloadTokenManager(origin: material.origin, workloadRecord: material.workloadRecord, transport: transport)
        } catch {
            throw VerifiedCredentialGateError.credentialInvalid
        }
        let me: AgentSelf
        do {
            me = try await MeshClient(transport: transport).agentSelf(origin: material.origin, auth: manager)
        } catch let error as VerifiedCredentialGateError {
            throw error
        } catch WorkloadTokenManagerError.refused(let code, _) {
            switch code {
            case "agent_paused": throw VerifiedCredentialGateError.agentPaused
            // Transient: never tell the operator to rebind for these.
            case "rate_limited", "dpop_replay": throw VerifiedCredentialGateError.verificationFailed
            default: throw VerifiedCredentialGateError.credentialRefused
            }
        } catch MeshClientError.transportUnavailable {
            throw VerifiedCredentialGateError.offline
        } catch {
            throw VerifiedCredentialGateError.verificationFailed
        }
        guard me.agentID == material.agentID else { throw VerifiedCredentialGateError.identityMismatch }
        if let handle = me.handle, handle != material.handle { throw VerifiedCredentialGateError.identityMismatch }
        if me.state == "paused" { throw VerifiedCredentialGateError.agentPaused }
        return VerifiedCredential(material: material, permissions: me.permissions, permissionsRevision: me.revision, auth: manager)
    }
}

/// `bind` / `unbind` / `status` for helper profiles.
public struct ProfileBindingService: Sendable {
    private let bindings: any V1ProfileBindingStore
    private let transport: any MeshTransport

    public init(bindings: any V1ProfileBindingStore, transport: any MeshTransport) {
        self.bindings = bindings
        self.transport = transport
    }

    private var gate: VerifiedCredentialGate {
        VerifiedCredentialGate(resolver: FileV1AgentResolver(bindings: bindings), transport: transport)
    }

    /// Point `profile` at an agent key file. The key must load and prove itself
    /// against MESH before the binding is written; an existing binding to a
    /// different agent is never silently replaced.
    public func bind(profile: ProfileName, keyFile: URL, origin: MeshOrigin?) async throws -> ProfileStatus {
        let material: V1AgentMaterial
        do {
            material = try V1AgentCredentialLoader.load(keyFile: keyFile, originOverride: origin)
        } catch {
            return ProfileStatus(profile: profile, material: nil, status: .credentialInvalid)
        }
        if let existing = try? bindings.read(for: profile),
           let current = try? V1AgentCredentialLoader.load(keyFile: URL(fileURLWithPath: existing.keyFile), originOverride: nil),
           current.agentID != material.agentID {
            return ProfileStatus(profile: profile, material: current, status: .identityMismatch)
        }
        let staged = InMemoryV1ProfileBindingStore()
        let binding = V1ProfileBinding(keyFile: keyFile.path, origin: origin?.value)
        try staged.write(binding, for: profile)
        do {
            let verified = try await VerifiedCredentialGate(resolver: FileV1AgentResolver(bindings: staged), transport: transport).credential(for: profile)
            try bindings.write(binding, for: profile)
            return ProfileStatus(profile: profile, material: material, status: .verified, permissions: verified.permissions, permissionsRevision: verified.permissionsRevision)
        } catch let error as VerifiedCredentialGateError {
            return ProfileStatus.failure(profile: profile, material: material, error: error)
        }
    }

    public func unbind(profile: ProfileName) throws {
        do { try bindings.delete(for: profile) } catch { throw VerifiedCredentialGateError.profileNotFound }
    }

    public func status(profile: ProfileName) async -> ProfileStatus {
        let material = try? gate.material(for: profile)
        do {
            let verified = try await gate.credential(for: profile)
            return ProfileStatus(profile: profile, material: verified.material, status: .verified, permissions: verified.permissions, permissionsRevision: verified.permissionsRevision)
        } catch let error as VerifiedCredentialGateError {
            return ProfileStatus.failure(profile: profile, material: material, error: error)
        } catch {
            return ProfileStatus(profile: profile, material: material, status: .verificationFailed)
        }
    }
}

public struct RenderedCLIOutput: Sendable {
    public let stdout: Data
    public let stderr: Data
    public let exitCode: Int32
}

public enum CLIOutputRenderer {
    public static func render(_ status: ProfileStatus) throws -> RenderedCLIOutput {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        var stdout = try encoder.encode(status)
        stdout.append(0x0a)
        let exitCode: Int32 = switch status.status {
        case .verified, .offlineUnverified: 0
        default: 1
        }
        return RenderedCLIOutput(stdout: stdout, stderr: Data(), exitCode: exitCode)
    }

    public static var operationFailure: RenderedCLIOutput {
        RenderedCLIOutput(
            stdout: Data(),
            stderr: Data("{\"safeToRetry\":false,\"status\":\"operation_failed\"}\n".utf8),
            exitCode: 1
        )
    }

    public static var localValidationFailure: RenderedCLIOutput {
        RenderedCLIOutput(
            stdout: Data(),
            stderr: Data("{\"safeToRetry\":true,\"status\":\"local_validation_failed\"}\n".utf8),
            exitCode: 64
        )
    }
}

public enum BoundedInputReader {
    public static let maximumInputBytes = 16 * 1024

    public static func readOneDocument(from handle: FileHandle, limit: Int = BoundedInputReader.maximumInputBytes) throws -> Data {
        var data = Data()
        while true {
            let chunk = handle.readData(ofLength: min(4096, limit + 1 - data.count))
            if chunk.isEmpty { break }
            data.append(chunk)
            guard data.count <= limit else { throw EnrollmentError.invalidInput }
        }
        guard !data.isEmpty else { throw EnrollmentError.invalidInput }
        return data
    }
}
