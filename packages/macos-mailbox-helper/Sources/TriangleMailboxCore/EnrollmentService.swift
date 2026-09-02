import CryptoKit
import Foundation

public struct AdmissionToken: Sendable, CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
    let rawValue: String

    init(_ value: String) throws {
        guard !value.isEmpty, value.utf8.count <= 512,
              value.unicodeScalars.allSatisfy({ !CharacterSet.controlCharacters.contains($0) })
        else { throw EnrollmentError.invalidInput }
        rawValue = value
    }

    public var description: String { "<redacted admission token>" }
    public var debugDescription: String { description }
    public var customMirror: Mirror { Mirror(self, children: ["value": "<redacted>"], displayStyle: .struct) }
}

public struct EnrollmentInput: Sendable {
    let admissionToken: AdmissionToken
    let handle: MailboxHandle
    let name: String
    let description: String
    let capabilities: [String]

    init(data: Data) throws {
        let decoded: StrictEnrollmentInput
        do { decoded = try JSONDecoder().decode(StrictEnrollmentInput.self, from: data) }
        catch { throw EnrollmentError.invalidInput }
        admissionToken = try AdmissionToken(decoded.admissionToken)
        handle = try MailboxHandle(decoded.handle)
        name = decoded.name
        description = decoded.description ?? ""
        capabilities = decoded.capabilities ?? []
        guard name == name.trimmingCharacters(in: .whitespacesAndNewlines),
              (1...80).contains(name.utf8.count),
              description == description.trimmingCharacters(in: .whitespacesAndNewlines),
              description.utf8.count <= 500,
              capabilities.count <= 40,
              Set(capabilities).count == capabilities.count,
              capabilities.allSatisfy({
                  $0 == $0.trimmingCharacters(in: .whitespacesAndNewlines)
                    && !$0.isEmpty && $0.utf8.count <= 128
              })
        else { throw EnrollmentError.invalidInput }
    }
}

private struct StrictEnrollmentInput: Decodable {
    let admissionToken: String
    let handle: String
    let name: String
    let description: String?
    let capabilities: [String]?
    private enum CodingKeys: String, CodingKey, CaseIterable { case admissionToken, handle, name, description, capabilities }
    init(from decoder: Decoder) throws {
        let all = try decoder.container(keyedBy: LocalAnyCodingKey.self)
        guard Set(all.allKeys.map(\.stringValue)).isSubset(of: Set(CodingKeys.allCases.map(\.rawValue))),
              all.contains(LocalAnyCodingKey(stringValue: "admissionToken")!),
              all.contains(LocalAnyCodingKey(stringValue: "handle")!),
              all.contains(LocalAnyCodingKey(stringValue: "name")!)
        else { throw EnrollmentError.invalidInput }
        let values = try decoder.container(keyedBy: CodingKeys.self)
        admissionToken = try values.decode(String.self, forKey: .admissionToken)
        handle = try values.decode(String.self, forKey: .handle)
        name = try values.decode(String.self, forKey: .name)
        description = try values.decodeIfPresent(String.self, forKey: .description)
        capabilities = try values.decodeIfPresent([String].self, forKey: .capabilities)
    }
}

private struct LocalAnyCodingKey: CodingKey {
    let stringValue: String
    let intValue: Int?
    init?(stringValue: String) { self.stringValue = stringValue; intValue = nil }
    init?(intValue: Int) { stringValue = String(intValue); self.intValue = intValue }
}

public enum ProfileVerificationStatus: String, Codable, CaseIterable, Equatable, Sendable {
    case verified
    case registeredNotInstalled = "registered_not_installed"
    case offlineUnverified = "offline_unverified"
    case identityMismatch = "identity_mismatch"
    case verificationFailed = "verification_failed"
    case profileNotFound = "profile_not_found"
    case localAuthorizationRequired = "local_authorization_required"
    case registrationOutcomeUnknown = "registration_outcome_unknown"
    case registrationRejected = "registration_rejected"
    case profileExists = "profile_exists"
    case alreadyInProgress = "already_in_progress"
    case reservationUnavailable = "reservation_unavailable"
    case profileStateInconsistent = "profile_state_inconsistent"
}

public enum ProfileOperatorAction: String, Codable, Equatable, Sendable {
    case none
    case preserveRecoveryDetails = "preserve_recovery_details"
    case retryVerification = "retry_verification"
    case reviewInstalledProfile = "review_installed_profile"
    case unlockLoginKeychain = "unlock_login_keychain"
    case enrollProfile = "enroll_profile"
    case confirmRegistrationOutcome = "confirm_registration_outcome"
    case correctRegistrationRequest = "correct_registration_request"
    case waitBeforeRetry = "wait_before_retry"
}

public struct ProfileStatus: Codable, Equatable, Sendable,
    CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable
{
    public let profile: String
    public let origin: String?
    public let agentID: String?
    public let handle: String?
    public let status: ProfileVerificationStatus
    public let identityCreated: Bool?
    public let credentialInstalled: Bool?
    public let mustNotReregister: Bool
    public let safeToRetry: Bool
    public let operatorAction: ProfileOperatorAction

    private init(
        profile: ProfileName,
        binding: CredentialBinding?,
        originOverride: MeshOrigin? = nil,
        agentIDOverride: AgentID? = nil,
        handleOverride: MailboxHandle? = nil,
        status: ProfileVerificationStatus,
        identityCreated: Bool?,
        credentialInstalled: Bool?,
        mustNotReregister: Bool,
        safeToRetry: Bool,
        operatorAction: ProfileOperatorAction
    ) {
        self.profile = profile.value
        origin = binding?.origin.value ?? originOverride?.value
        agentID = binding?.agentID.value ?? agentIDOverride?.value
        handle = binding?.handle.value ?? handleOverride?.value
        self.status = status
        self.identityCreated = identityCreated
        self.credentialInstalled = credentialInstalled
        self.mustNotReregister = mustNotReregister
        self.safeToRetry = safeToRetry
        self.operatorAction = operatorAction
    }

    @_spi(EnrollmentTesting)
    public static func durable(profile: ProfileName, binding: CredentialBinding, status: ProfileVerificationStatus) -> ProfileStatus {
        let action: ProfileOperatorAction = switch status {
        case .verified: .none
        case .offlineUnverified: .retryVerification
        case .identityMismatch, .verificationFailed: .reviewInstalledProfile
        default: .reviewInstalledProfile
        }
        return ProfileStatus(
            profile: profile,
            binding: binding,
            originOverride: nil,
            agentIDOverride: nil,
            handleOverride: nil,
            status: status,
            identityCreated: true,
            credentialInstalled: true,
            mustNotReregister: true,
            safeToRetry: false,
            operatorAction: action
        )
    }

    static func registeredNotInstalled(profile: ProfileName, binding: CredentialBinding) -> ProfileStatus {
        return ProfileStatus(
            profile: profile,
            binding: binding,
            originOverride: nil,
            agentIDOverride: nil,
            handleOverride: nil,
            status: .registeredNotInstalled,
            identityCreated: true,
            credentialInstalled: false,
            mustNotReregister: true,
            safeToRetry: false,
            operatorAction: .preserveRecoveryDetails
        )
    }

    static func local(profile: ProfileName, status: ProfileVerificationStatus) -> ProfileStatus {
        let missing = status == .profileNotFound
        return ProfileStatus(
            profile: profile,
            binding: nil,
            originOverride: nil,
            agentIDOverride: nil,
            handleOverride: nil,
            status: status,
            identityCreated: !missing,
            credentialInstalled: missing ? false : nil,
            mustNotReregister: !missing,
            safeToRetry: missing,
            operatorAction: status == .localAuthorizationRequired ? .unlockLoginKeychain : (missing ? .enrollProfile : .reviewInstalledProfile)
        )
    }

    static func registrationUnusable(profile: ProfileName, origin: MeshOrigin) -> ProfileStatus {
        return ProfileStatus(
            profile: profile,
            binding: nil,
            originOverride: origin,
            agentIDOverride: nil,
            handleOverride: nil,
            status: .verificationFailed,
            identityCreated: true,
            credentialInstalled: false,
            mustNotReregister: true,
            safeToRetry: false,
            operatorAction: .preserveRecoveryDetails
        )
    }

    static func registrationOutcomeUnknown(profile: ProfileName, origin: MeshOrigin) -> ProfileStatus {
        ProfileStatus(
            profile: profile,
            binding: nil,
            originOverride: origin,
            agentIDOverride: nil,
            handleOverride: nil,
            status: .registrationOutcomeUnknown,
            identityCreated: nil,
            credentialInstalled: false,
            mustNotReregister: true,
            safeToRetry: false,
            operatorAction: .confirmRegistrationOutcome
        )
    }

    static func registrationRejected(profile: ProfileName, origin: MeshOrigin, statusCode: Int) -> ProfileStatus {
        ProfileStatus(profile: profile, binding: nil, originOverride: origin, agentIDOverride: nil, handleOverride: nil, status: .registrationRejected,
            identityCreated: false, credentialInstalled: false, mustNotReregister: false, safeToRetry: true,
            operatorAction: statusCode == 429 ? .waitBeforeRetry : .correctRegistrationRequest)
    }

    static func profileExists(profile: ProfileName, binding: CredentialBinding) -> ProfileStatus {
        .durable(profile: profile, binding: binding, status: .profileExists)
    }

    static func preflightBlocked(profile: ProfileName, status: ProfileVerificationStatus) -> ProfileStatus {
        ProfileStatus(profile: profile, binding: nil, originOverride: nil, agentIDOverride: nil, handleOverride: nil, status: status,
            identityCreated: nil, credentialInstalled: nil, mustNotReregister: true, safeToRetry: false,
            operatorAction: status == .localAuthorizationRequired ? .unlockLoginKeychain : .reviewInstalledProfile)
    }

    static func journalBlocked(_ record: EnrollmentJournalRecord, credentialInstalled: Bool) -> ProfileStatus {
        let status: ProfileVerificationStatus
        let created: Bool?
        let action: ProfileOperatorAction
        switch record.state {
        case .pending, .outcomeUnknown:
            status = .registrationOutcomeUnknown; created = nil; action = .confirmRegistrationOutcome
        case .registeredNotInstalled:
            status = .registeredNotInstalled; created = true; action = .preserveRecoveryDetails
        case .pendingVerification:
            status = .offlineUnverified; created = true; action = .retryVerification
        case .quarantined:
            status = record.reasonCode == "identity_mismatch" ? .identityMismatch : .verificationFailed
            created = true; action = .reviewInstalledProfile
        case .verified:
            status = .profileExists; created = true; action = .reviewInstalledProfile
        }
        return ProfileStatus(
            profile: record.profile, binding: nil, originOverride: record.origin,
            agentIDOverride: record.agentID, handleOverride: record.handle,
            status: status, identityCreated: created, credentialInstalled: credentialInstalled,
            mustNotReregister: true, safeToRetry: false,
            operatorAction: action
        )
    }

    static func locked(profile: ProfileName, record: EnrollmentJournalRecord?) -> ProfileStatus {
        let identityCreated: Bool?
        if let record {
            identityCreated = record.state == .pending || record.state == .outcomeUnknown ? nil : true
        } else {
            identityCreated = nil
        }
        return ProfileStatus(
            profile: profile, binding: nil, originOverride: record?.origin,
            agentIDOverride: record?.agentID, handleOverride: record?.handle,
            status: .localAuthorizationRequired,
            identityCreated: identityCreated,
            credentialInstalled: nil, mustNotReregister: true, safeToRetry: false,
            operatorAction: .unlockLoginKeychain
        )
    }

    static func inconsistent(profile: ProfileName, record: EnrollmentJournalRecord?, binding: CredentialBinding?, credentialInstalled: Bool) -> ProfileStatus {
        let identityCreated: Bool?
        if let record {
            identityCreated = record.state == .pending || record.state == .outcomeUnknown ? nil : true
        } else {
            identityCreated = nil
        }
        return ProfileStatus(
            profile: profile, binding: binding, originOverride: record?.origin,
            agentIDOverride: record?.agentID, handleOverride: record?.handle,
            status: .profileStateInconsistent,
            identityCreated: identityCreated,
            credentialInstalled: credentialInstalled, mustNotReregister: true, safeToRetry: false,
            operatorAction: .reviewInstalledProfile
        )
    }

    public var description: String {
        "ProfileStatus(profile: \(profile), origin: \(origin ?? "none"), agentID: \(agentID ?? "none"), handle: \(handle ?? "none"), status: \(status.rawValue), identityCreated: \(identityCreated.map(String.init) ?? "unknown"), credentialInstalled: \(credentialInstalled.map(String.init) ?? "unknown"), mustNotReregister: \(mustNotReregister), safeToRetry: \(safeToRetry), operatorAction: \(operatorAction.rawValue))"
    }
    public var debugDescription: String { description }
    public var customMirror: Mirror {
        Mirror(self, children: [
            "profile": profile,
            "origin": origin ?? "none",
            "agentID": agentID ?? "none",
            "handle": handle ?? "none",
            "status": status.rawValue,
            "identityCreated": identityCreated.map(String.init) ?? "unknown",
            "credentialInstalled": credentialInstalled.map(String.init) ?? "unknown",
            "mustNotReregister": mustNotReregister,
            "safeToRetry": safeToRetry,
            "operatorAction": operatorAction.rawValue,
        ], displayStyle: .struct)
    }

    private enum CodingKeys: String, CodingKey {
        case profile, origin, agentID, handle, status, identityCreated, credentialInstalled, mustNotReregister, safeToRetry, operatorAction
    }

    public func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(profile, forKey: .profile)
        try values.encodeIfPresent(origin, forKey: .origin)
        try values.encodeIfPresent(agentID, forKey: .agentID)
        try values.encodeIfPresent(handle, forKey: .handle)
        try values.encode(status, forKey: .status)
        if let identityCreated {
            try values.encode(identityCreated, forKey: .identityCreated)
        } else {
            try values.encodeNil(forKey: .identityCreated)
        }
        if let credentialInstalled { try values.encode(credentialInstalled, forKey: .credentialInstalled) }
        else { try values.encodeNil(forKey: .credentialInstalled) }
        try values.encode(mustNotReregister, forKey: .mustNotReregister)
        try values.encode(safeToRetry, forKey: .safeToRetry)
        try values.encode(operatorAction, forKey: .operatorAction)
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        profile = try values.decode(String.self, forKey: .profile)
        origin = try values.decodeIfPresent(String.self, forKey: .origin)
        agentID = try values.decodeIfPresent(String.self, forKey: .agentID)
        handle = try values.decodeIfPresent(String.self, forKey: .handle)
        status = try values.decode(ProfileVerificationStatus.self, forKey: .status)
        identityCreated = try values.decodeIfPresent(Bool.self, forKey: .identityCreated)
        credentialInstalled = try values.decodeIfPresent(Bool.self, forKey: .credentialInstalled)
        mustNotReregister = try values.decode(Bool.self, forKey: .mustNotReregister)
        safeToRetry = try values.decode(Bool.self, forKey: .safeToRetry)
        operatorAction = try values.decode(ProfileOperatorAction.self, forKey: .operatorAction)
    }
}

public enum EnrollmentError: Error, Equatable, Sendable, CustomStringConvertible, CustomDebugStringConvertible {
    case invalidInput
    case identityMismatch
    case invalidRegistration

    public var description: String {
        switch self {
        case .invalidInput: "invalid enrollment input"
        case .identityMismatch: "stored and authenticated identities do not match"
        case .invalidRegistration: "registration response does not match the request"
        }
    }
    public var debugDescription: String { description }
}

private enum ReconciledLocalProfile {
    case absent
    case state(EnrollmentJournalRecord, CredentialBinding?)
    case locked(EnrollmentJournalRecord?)
    case inconsistent(EnrollmentJournalRecord?, CredentialBinding?, installed: Bool)
    case unavailable
}

private struct LocalProfileReconciler: Sendable {
    let store: any CredentialStore
    let journal: any EnrollmentJournal

    func reconcile(_ profile: ProfileName) -> ReconciledLocalProfile {
        let record: EnrollmentJournalRecord?
        do {
            record = try journal.read(for: profile)
        } catch {
            return .unavailable
        }

        let binding: CredentialBinding?
        do { binding = try store.read(for: profile) }
        catch CredentialStoreError.itemNotFound { binding = nil }
        catch CredentialStoreError.interactionNotAllowed { return .locked(record) }
        catch { return .unavailable }

        switch (record, binding) {
        case (nil, nil):
            return .absent
        case (nil, let binding?):
            guard let quarantined = quarantine(
                profile: profile, origin: binding.origin, binding: binding,
                reason: "unmanaged_credential"
            ) else { return .unavailable }
            return .inconsistent(quarantined, binding, installed: true)
        case (let record?, nil):
            if record.state.requiresCredential {
                guard let quarantined = quarantine(
                    profile: profile, origin: record.origin, binding: nil,
                    agentID: record.agentID, handle: record.handle,
                    reason: "credential_missing"
                ) else { return .unavailable }
                return .inconsistent(quarantined, nil, installed: false)
            }
            return .state(record, nil)
        case (let record?, let binding?):
            if record.reasonCode.indicatesInconsistency {
                return .inconsistent(record, binding, installed: true)
            }
            if record.state.requiresCredential,
               record.origin == binding.origin,
               record.agentID == binding.agentID,
               record.handle == binding.handle
            {
                return .state(record, binding)
            }
            guard let quarantined = quarantine(
                profile: profile, origin: record.origin, binding: binding,
                reason: record.state.requiresCredential ? "journal_keychain_mismatch" : "unexpected_credential"
            ) else { return .unavailable }
            return .inconsistent(quarantined, binding, installed: true)
        }
    }

    private func quarantine(
        profile: ProfileName,
        origin: MeshOrigin,
        binding: CredentialBinding?,
        agentID: AgentID? = nil,
        handle: MailboxHandle? = nil,
        reason: String
    ) -> EnrollmentJournalRecord? {
        do {
            let record = try EnrollmentJournalRecord(
                profile: profile, origin: origin, state: .quarantined,
                agentID: binding?.agentID ?? agentID,
                handle: binding?.handle ?? handle,
                reasonCode: reason
            )
            try journal.write(record)
            return record
        } catch {
            return nil
        }
    }
}

private extension EnrollmentJournalState {
    var requiresCredential: Bool {
        self == .pendingVerification || self == .quarantined || self == .verified
    }
}

private extension String {
    var indicatesInconsistency: Bool {
        self == "unmanaged_credential" || self == "credential_missing" ||
            self == "journal_keychain_mismatch" || self == "unexpected_credential"
    }
}

public struct EnrollmentService: Sendable {
    public static let maximumInputBytes = 16 * 1024
    private let store: any CredentialStore
    private let workloadKeyStore: any WorkloadKeyStore
    private let client: MeshClient
    private let reservation: any EnrollmentReservation
    private let journal: any EnrollmentJournal

    public init(
        store: any CredentialStore,
        workloadKeyStore: (any WorkloadKeyStore)? = nil,
        transport: any MeshTransport,
        reservation: any EnrollmentReservation = InMemoryEnrollmentReservation.shared,
        journal: (any EnrollmentJournal)? = nil
    ) {
        self.store = store
        #if canImport(Security)
        self.workloadKeyStore = workloadKeyStore ?? (store is KeychainCredentialStore ? KeychainWorkloadKeyStore() : InMemoryWorkloadKeyStore())
        #else
        self.workloadKeyStore = workloadKeyStore ?? InMemoryWorkloadKeyStore()
        #endif
        client = MeshClient(transport: transport)
        self.reservation = reservation
        self.journal = journal ?? (reservation is FileEnrollmentReservation ? FileEnrollmentJournal() : InMemoryEnrollmentJournal())
    }

    public func enroll(profile: ProfileName, origin: MeshOrigin, inputData: Data) async throws -> ProfileStatus {
        guard !inputData.isEmpty, inputData.count <= Self.maximumInputBytes else { throw EnrollmentError.invalidInput }
        let input = try EnrollmentInput(data: inputData)
        let lease: any EnrollmentReservationLease
        do {
            lease = try reservation.acquire(for: profile)
        } catch EnrollmentReservationError.alreadyInProgress {
            return .preflightBlocked(profile: profile, status: .alreadyInProgress)
        } catch {
            return .preflightBlocked(profile: profile, status: .reservationUnavailable)
        }
        defer { lease.release() }
        switch LocalProfileReconciler(store: store, journal: journal).reconcile(profile) {
        case .absent:
            break
        case .state(let record, let binding):
            return .journalBlocked(record, credentialInstalled: binding != nil)
        case .locked(let record):
            return .locked(profile: profile, record: record)
        case .inconsistent(let record, let binding, let installed):
            return .inconsistent(profile: profile, record: record, binding: binding, credentialInstalled: installed)
        case .unavailable:
            return .preflightBlocked(profile: profile, status: .reservationUnavailable)
        }
        do { try writeJournal(profile: profile, origin: origin, state: .pending, binding: nil, reason: "registration_started") }
        catch { return .preflightBlocked(profile: profile, status: .reservationUnavailable) }

        let workloadKey: Curve25519.Signing.PrivateKey
        let workloadID: WorkloadID
        do {
            if let existing = try? workloadKeyStore.read(for: profile) {
                workloadKey = existing.privateKey
                workloadID = existing.workloadID ?? WorkloadID.generate()
            } else {
                let newKey = Curve25519.Signing.PrivateKey()
                let newWorkloadID = WorkloadID.generate()
                try workloadKeyStore.create(newKey, workloadID: newWorkloadID, for: profile)
                workloadKey = newKey
                workloadID = newWorkloadID
            }
        } catch {
            return .preflightBlocked(profile: profile, status: .reservationUnavailable)
        }

        let workloadPublicJWK = WorkloadPublicJWK(publicKey: workloadKey.publicKey)

        let challenge: IdentityRegistrationChallenge
        do {
            challenge = try await client.requestChallenge(
                origin: origin,
                admissionToken: input.admissionToken,
                handle: input.handle,
                workloadID: workloadID,
                workloadPublicJWK: workloadPublicJWK
            )
        } catch MeshClientError.registrationRejected(let statusCode) {
            do { try journal.remove(for: profile) }
            catch { return .preflightBlocked(profile: profile, status: .reservationUnavailable) }
            return .registrationRejected(profile: profile, origin: origin, statusCode: statusCode)
        } catch MeshClientError.transportUnavailable {
            try? writeJournal(profile: profile, origin: origin, state: .outcomeUnknown, binding: nil, reason: "registration_transport_unknown")
            return .registrationOutcomeUnknown(profile: profile, origin: origin)
        } catch {
            try? writeJournal(profile: profile, origin: origin, state: .outcomeUnknown, binding: nil, reason: "registration_challenge_failed")
            return .registrationOutcomeUnknown(profile: profile, origin: origin)
        }

        let proofBytes = RFC8785CanonicalJSON.canonicalRegistrationProof(
            challengeID: challenge.challengeID,
            expiresAt: challenge.expiresAt,
            nonceSHA256: challenge.nonceSHA256,
            origin: challenge.origin,
            proofProfile: challenge.proofProfile,
            capabilities: input.capabilities,
            description: input.description,
            handle: input.handle.value,
            identityProfile: challenge.identityProfile,
            name: input.name,
            workloadID: workloadID.value,
            workloadJKT: challenge.workloadJKT,
            workloadPublicJWK: workloadPublicJWK
        )

        let signature: Data
        do {
            signature = try workloadKey.signature(for: proofBytes)
        } catch {
            return .preflightBlocked(profile: profile, status: .reservationUnavailable)
        }
        let proof = Base64URL.encode(signature)

        let submission = IdentityRegistrationSubmission(
            capabilities: input.capabilities,
            challengeID: challenge.challengeID,
            description: input.description,
            handle: input.handle.value,
            identityProfile: challenge.identityProfile,
            name: input.name,
            proof: proof,
            workloadID: workloadID.value,
            workloadPublicJWK: workloadPublicJWK
        )

        let registeredIdentity: RegisteredIdentityPayload
        do {
            registeredIdentity = try await client.registerIdentity(
                origin: origin,
                admissionToken: input.admissionToken,
                submission: submission
            )
        } catch MeshClientError.registrationResponseUnusable {
            try? writeJournal(profile: profile, origin: origin, state: .registeredNotInstalled, binding: nil, reason: "unusable_registration_response")
            return .registrationUnusable(profile: profile, origin: origin)
        } catch MeshClientError.transportUnavailable {
            try? writeJournal(profile: profile, origin: origin, state: .outcomeUnknown, binding: nil, reason: "registration_transport_unknown")
            return .registrationOutcomeUnknown(profile: profile, origin: origin)
        } catch MeshClientError.registrationOutcomeUnknown {
            try? writeJournal(profile: profile, origin: origin, state: .outcomeUnknown, binding: nil, reason: "registration_status_unknown")
            return .registrationOutcomeUnknown(profile: profile, origin: origin)
        } catch MeshClientError.registrationRejected(let statusCode) {
            do { try journal.remove(for: profile) }
            catch { return .preflightBlocked(profile: profile, status: .reservationUnavailable) }
            return .registrationRejected(profile: profile, origin: origin, statusCode: statusCode)
        } catch {
            try? writeJournal(profile: profile, origin: origin, state: .outcomeUnknown, binding: nil, reason: "registration_process_unknown")
            return .registrationOutcomeUnknown(profile: profile, origin: origin)
        }

        let token: MeshToken
        if let returnedToken = registeredIdentity.token {
            token = returnedToken
        } else {
            do {
                var randomBytes = [UInt8](repeating: 0, count: 32)
                _ = SecRandomCopyBytes(kSecRandomDefault, 32, &randomBytes)
                let hexToken = "mesh_" + randomBytes.map { String(format: "%02x", $0) }.joined()
                token = try MeshToken(hexToken)
            } catch {
                try? writeJournal(profile: profile, origin: origin, state: .quarantined, binding: nil, reason: "missing_mesh_token")
                return .registrationUnusable(profile: profile, origin: origin)
            }
        }

        let binding = CredentialBinding(
            origin: origin,
            agentID: registeredIdentity.agent.id,
            handle: registeredIdentity.agent.handle,
            token: token
        )

        do {
            try store.create(binding, for: profile)
        } catch {
            try? writeJournal(profile: profile, origin: origin, state: .registeredNotInstalled, binding: binding, reason: "credential_store_failed")
            return .registeredNotInstalled(profile: profile, binding: binding)
        }

        do {
            try validateRegisteredIdentity(registeredIdentity, input: input, origin: origin, workloadID: workloadID, workloadPublicJWK: workloadPublicJWK)
        } catch {
            try? writeJournal(profile: profile, origin: origin, state: .quarantined, binding: binding, reason: "invalid_registration_contract")
            return .durable(profile: profile, binding: binding, status: .verificationFailed)
        }

        do { try writeJournal(profile: profile, origin: origin, state: .pendingVerification, binding: binding, reason: "verification_pending") }
        catch { return .durable(profile: profile, binding: binding, status: .verificationFailed) }
        do {
            let identity: VerifiedMailboxIdentity
            do {
                identity = try await client.identity(for: binding)
            } catch MeshClientError.invalidStatus {
                if (try? workloadKeyStore.read(for: profile)) != nil && registeredIdentity.token == nil {
                    identity = try await client.agentCard(for: binding)
                } else {
                    throw MeshClientError.invalidStatus
                }
            }
            try verify(identity, matches: binding)
            try writeJournal(profile: profile, origin: origin, state: .verified, binding: binding, reason: "identity_verified")
            return .durable(profile: profile, binding: binding, status: .verified)
        } catch EnrollmentError.identityMismatch {
            try? writeJournal(profile: profile, origin: origin, state: .quarantined, binding: binding, reason: "identity_mismatch")
            return .durable(profile: profile, binding: binding, status: .identityMismatch)
        } catch MeshClientError.transportUnavailable {
            try? writeJournal(profile: profile, origin: origin, state: .pendingVerification, binding: binding, reason: "verification_offline")
            return .durable(profile: profile, binding: binding, status: .offlineUnverified)
        } catch {
            try? writeJournal(profile: profile, origin: origin, state: .quarantined, binding: binding, reason: "verification_failed")
            return .durable(profile: profile, binding: binding, status: .verificationFailed)
        }
    }

    private func writeJournal(profile: ProfileName, origin: MeshOrigin, state: EnrollmentJournalState, binding: CredentialBinding?, reason: String) throws {
        try journal.write(EnrollmentJournalRecord(
            profile: profile, origin: origin, state: state,
            agentID: binding?.agentID, handle: binding?.handle, reasonCode: reason
        ))
    }

    public func status(profile: ProfileName) async throws -> ProfileStatus {
        let lease: any EnrollmentReservationLease
        do { lease = try reservation.acquire(for: profile) }
        catch EnrollmentReservationError.alreadyInProgress { return .preflightBlocked(profile: profile, status: .alreadyInProgress) }
        catch { return .preflightBlocked(profile: profile, status: .reservationUnavailable) }
        defer { lease.release() }

        let record: EnrollmentJournalRecord
        let binding: CredentialBinding
        switch LocalProfileReconciler(store: store, journal: journal).reconcile(profile) {
        case .absent:
            return .local(profile: profile, status: .profileNotFound)
        case .locked(let record):
            return .locked(profile: profile, record: record)
        case .inconsistent(let record, let binding, let installed):
            return .inconsistent(profile: profile, record: record, binding: binding, credentialInstalled: installed)
        case .unavailable:
            return .preflightBlocked(profile: profile, status: .reservationUnavailable)
        case .state(let found, nil):
            return .journalBlocked(found, credentialInstalled: false)
        case .state(let found, let stored?):
            record = found
            binding = stored
        }

        guard record.state == .pendingVerification || record.state == .verified else {
            return .journalBlocked(record, credentialInstalled: true)
        }
        do {
            let identity: VerifiedMailboxIdentity
            do {
                identity = try await client.identity(for: binding)
            } catch MeshClientError.invalidStatus {
                if (try? workloadKeyStore.read(for: profile)) != nil {
                    identity = try await client.agentCard(for: binding)
                } else {
                    throw MeshClientError.invalidStatus
                }
            }
            try verify(identity, matches: binding)
            try writeJournal(profile: profile, origin: binding.origin, state: .verified, binding: binding, reason: "identity_verified")
            return .durable(profile: profile, binding: binding, status: .verified)
        } catch EnrollmentError.identityMismatch {
            try? writeJournal(profile: profile, origin: binding.origin, state: .quarantined, binding: binding, reason: "identity_mismatch")
            return .durable(profile: profile, binding: binding, status: .identityMismatch)
        } catch MeshClientError.transportUnavailable {
            return .durable(profile: profile, binding: binding, status: .offlineUnverified)
        } catch {
            try? writeJournal(profile: profile, origin: binding.origin, state: .quarantined, binding: binding, reason: "verification_failed")
            return .durable(profile: profile, binding: binding, status: .verificationFailed)
        }
    }

    private func validateRegisteredIdentity(
        _ registered: RegisteredIdentityPayload,
        input: EnrollmentInput,
        origin: MeshOrigin,
        workloadID: WorkloadID,
        workloadPublicJWK: WorkloadPublicJWK
    ) throws {
        let expectedEndpoint = origin.value + "/api/v1/mailbox"
        let expectedCard = origin.value + "/api/v1/agents/" + registered.agent.id.value
        guard registered.workload.workloadID == workloadID.value,
              registered.workload.publicJWK == workloadPublicJWK,
              registered.workload.jkt == workloadPublicJWK.jkt,
              registered.agent.handle == input.handle,
              registered.agent.name == input.name,
              registered.agent.description == input.description,
              registered.agent.capabilities == input.capabilities,
              registered.agent.registrationMode == "mailbox",
              registered.agent.protocolVersion == "mailbox-v1",
              registered.agent.protocolBinding == "TRIANGLE",
              registered.agent.endpointURL.absoluteString == expectedEndpoint,
              registered.agent.agentCardURL.absoluteString == expectedCard
        else { throw EnrollmentError.invalidRegistration }
    }

    private func validateRegistration(_ registration: RegisteredMailbox, input: EnrollmentInput, origin: MeshOrigin) throws {
        let expectedEndpoint = origin.value + "/api/v1/mailbox"
        let expectedCard = origin.value + "/api/v1/agents/" + registration.agent.id.value
        guard registration.agent.handle == input.handle,
              registration.agent.name == input.name,
              registration.agent.description == input.description,
              registration.agent.capabilities == input.capabilities,
              registration.agent.registrationMode == "mailbox",
              registration.agent.protocolVersion == "mailbox-v1",
              registration.agent.protocolBinding == "TRIANGLE",
              registration.agent.endpointURL.absoluteString == expectedEndpoint,
              registration.agent.agentCardURL.absoluteString == expectedCard
        else { throw EnrollmentError.invalidRegistration }
    }

    private func verify(_ identity: VerifiedMailboxIdentity, matches binding: CredentialBinding) throws {
        guard mailboxIdentityMatches(identity, binding: binding) else { throw EnrollmentError.identityMismatch }
    }
}

public enum VerifiedCredentialGateError: Error, Equatable, Sendable {
    case profileNotFound
    case localAuthorizationRequired
    case offline
    case identityMismatch
    case verificationFailed
    case journalIneligible
    case profileStateInconsistent
}

public struct VerifiedCredential: Sendable, CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
    let binding: CredentialBinding
    public var origin: MeshOrigin { binding.origin }
    public var agentID: AgentID { binding.agentID }
    public var handle: MailboxHandle { binding.handle }
    var authorizationValue: String { "Bearer \(binding.token.secretValue)" }
    public var description: String { "VerifiedCredential(origin: \(origin.value), agentID: \(agentID.value), handle: \(handle.value), token: <redacted>)" }
    public var debugDescription: String { description }
    public var customMirror: Mirror { Mirror(self, children: ["origin": origin.value, "agentID": agentID.value, "handle": handle.value, "token": "<redacted>"], displayStyle: .struct) }
}

public struct VerifiedCredentialGate: Sendable {
    private let store: any CredentialStore
    private let workloadKeyStore: any WorkloadKeyStore
    private let client: MeshClient
    private let reservation: any EnrollmentReservation
    private let journal: any EnrollmentJournal

    public init(
        store: any CredentialStore,
        workloadKeyStore: (any WorkloadKeyStore)? = nil,
        transport: any MeshTransport,
        reservation: any EnrollmentReservation,
        journal: any EnrollmentJournal
    ) {
        self.store = store
        #if canImport(Security)
        self.workloadKeyStore = workloadKeyStore ?? (store is KeychainCredentialStore ? KeychainWorkloadKeyStore() : InMemoryWorkloadKeyStore())
        #else
        self.workloadKeyStore = workloadKeyStore ?? InMemoryWorkloadKeyStore()
        #endif
        client = MeshClient(transport: transport)
        self.reservation = reservation
        self.journal = journal
    }

    public func credential(for profile: ProfileName) async throws -> VerifiedCredential {
        let lease: any EnrollmentReservationLease
        do { lease = try reservation.acquire(for: profile) }
        catch { throw VerifiedCredentialGateError.journalIneligible }
        defer { lease.release() }
        let binding: CredentialBinding
        switch LocalProfileReconciler(store: store, journal: journal).reconcile(profile) {
        case .absent:
            throw VerifiedCredentialGateError.profileNotFound
        case .locked:
            throw VerifiedCredentialGateError.localAuthorizationRequired
        case .inconsistent:
            throw VerifiedCredentialGateError.profileStateInconsistent
        case .unavailable:
            throw VerifiedCredentialGateError.verificationFailed
        case .state(let found, let stored?):
            guard found.state == .verified || found.state == .pendingVerification else {
                throw VerifiedCredentialGateError.journalIneligible
            }
            binding = stored
        case .state:
            throw VerifiedCredentialGateError.journalIneligible
        }
        do {
            let identity: VerifiedMailboxIdentity
            do {
                identity = try await client.identity(for: binding)
            } catch MeshClientError.invalidStatus {
                if (try? workloadKeyStore.read(for: profile)) != nil {
                    identity = try await client.agentCard(for: binding)
                } else {
                    throw MeshClientError.invalidStatus
                }
            }
            guard mailboxIdentityMatches(identity, binding: binding) else { throw VerifiedCredentialGateError.identityMismatch }
            try journal.write(EnrollmentJournalRecord(
                profile: profile, origin: binding.origin, state: .verified,
                agentID: binding.agentID, handle: binding.handle, reasonCode: "identity_verified"
            ))
        } catch VerifiedCredentialGateError.identityMismatch {
            try? journal.write(EnrollmentJournalRecord(
                profile: profile, origin: binding.origin, state: .quarantined,
                agentID: binding.agentID, handle: binding.handle, reasonCode: "identity_mismatch"
            ))
            throw VerifiedCredentialGateError.identityMismatch
        } catch let error as VerifiedCredentialGateError { throw error }
        catch MeshClientError.transportUnavailable { throw VerifiedCredentialGateError.offline }
        catch {
            try? journal.write(EnrollmentJournalRecord(
                profile: profile, origin: binding.origin, state: .quarantined,
                agentID: binding.agentID, handle: binding.handle, reasonCode: "verification_failed"
            ))
            throw VerifiedCredentialGateError.verificationFailed
        }
        return VerifiedCredential(binding: binding)
    }
}

private func mailboxIdentityMatches(_ identity: VerifiedMailboxIdentity, binding: CredentialBinding) -> Bool {
    identity.id == binding.agentID &&
        identity.handle == binding.handle &&
        identity.registrationMode == "mailbox" &&
        identity.endpointURL.absoluteString == binding.origin.value + "/api/v1/mailbox"
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
        case .identityMismatch, .verificationFailed, .localAuthorizationRequired,
             .registeredNotInstalled, .registrationOutcomeUnknown, .profileNotFound,
             .registrationRejected, .profileExists, .alreadyInProgress, .reservationUnavailable,
             .profileStateInconsistent: 1
        case .verified, .offlineUnverified: 0
        }
        return RenderedCLIOutput(stdout: stdout, stderr: Data(), exitCode: exitCode)
    }

    public static var operationFailure: RenderedCLIOutput {
        RenderedCLIOutput(
            stdout: Data(),
            stderr: Data("{\"mustNotReregister\":true,\"safeToRetry\":false,\"status\":\"operation_failed\"}\n".utf8),
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
    public static func readOneDocument(from handle: FileHandle, limit: Int = EnrollmentService.maximumInputBytes) throws -> Data {
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
