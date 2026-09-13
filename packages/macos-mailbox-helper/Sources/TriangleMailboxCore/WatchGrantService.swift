import Foundation

public enum WatchGrantServiceError: Error, Equatable, Sendable, CustomStringConvertible, CustomDebugStringConvertible {
    case keychainUnavailable
    case helperUnavailable
    case noEventDrivenMembers
    case actorNotDeclared
    case interactiveDeliveryExcluded
    case workloadAuthUnavailable
    case workloadKeyMissing
    case credentialMissing
    case invalidCursor
    case rejected(statusCode: Int, code: String)
    case resyncRequired(restartCursor: Int)
    case invalidResponse

    public var description: String {
        switch self {
        case .keychainUnavailable: "watch grant storage is unavailable"
        case .helperUnavailable: "watch grant helper is unavailable"
        case .noEventDrivenMembers: "no notify-eligible profiles are available for a watch grant"
        case .actorNotDeclared: "actor profile is not declared in the watch grant membership"
        case .interactiveDeliveryExcluded: "mcp-interactive profiles cannot act as watch grant actors"
        case .workloadAuthUnavailable: "workload authentication is unavailable for watch grant operations"
        case .workloadKeyMissing: "workload key material is missing for watch grant operations"
        case .credentialMissing: "watch grant credential is not installed"
        case .invalidCursor: "watch cursor is invalid"
        case .rejected(_, let code): "watch grant request was rejected (\(code))"
        case .resyncRequired: "watch cursor requires resync"
        case .invalidResponse: "watch grant response was invalid"
        }
    }

    public var debugDescription: String { description }
}

public protocol WatchGrantAuthProviding: Sendable {
    func authorizationHeaders(for profile: ProfileName, method: String, url: URL) async throws -> [String: String]
}

public struct WatchGrantService: Sendable {
    private let store: any WatchGrantStore
    private let client: MeshWatchClient
    private let auth: any WatchGrantAuthProviding
    private let credentialGate: VerifiedCredentialGate
    private let instanceStore: (any ClientInstanceStore)?

    public init(
        store: any WatchGrantStore,
        transport: any MeshTransport,
        auth: any WatchGrantAuthProviding,
        credentialGate: VerifiedCredentialGate,
        instanceStore: (any ClientInstanceStore)? = nil
    ) {
        self.store = store
        self.client = MeshWatchClient(transport: transport)
        self.auth = auth
        self.credentialGate = credentialGate
        self.instanceStore = instanceStore
    }

    /// Creates, joins, and finalizes a staged watch grant for event-driven members, then stores the opaque credential.
    public func ensureGrant(
        installationID: InstallationID,
        actorProfile: ProfileName,
        memberProfiles: [ProfileName]? = nil
    ) async throws -> WatchGrantOperatorStatus {
        let members = try await resolveMembers(actorProfile: actorProfile, memberProfiles: memberProfiles)
        let actorCredential = try await credentialGate.credential(for: actorProfile)
        let origin = actorCredential.origin
        let agentIDs = members.map(\.agentID)
        guard agentIDs.contains(actorCredential.binding.agentID) else {
            throw WatchGrantServiceError.actorNotDeclared
        }

        var existing = try? store.read(for: installationID)
        let replacement = existing?.watchCredential
        if let existing, existing.origin != origin {
            throw WatchGrantServiceError.invalidResponse
        }

        let createURL = URL(string: origin.value + "/api/v1/mailbox/watch/grants")!
        let createHeaders = try await auth.authorizationHeaders(for: actorProfile, method: "POST", url: createURL)
        let staged: StagedWatchGrant
        do {
            staged = try await createGrantRecoveringStaleLocalBinding(
                installationID: installationID,
                origin: origin,
                agentIDs: agentIDs,
                authorizationHeaders: createHeaders,
                replacementCredential: replacement,
                localBindingPresent: &existing
            )
        } catch let error as WatchGrantServiceError {
            throw error
        } catch {
            throw WatchGrantServiceError.invalidResponse
        }

        for member in members {
            let joinURL = URL(string: origin.value + "/api/v1/mailbox/watch/grants/\(staged.grantID.value)/join")!
            let joinHeaders = try await auth.authorizationHeaders(for: member.profile, method: "POST", url: joinURL)
            do {
                try await client.joinGrant(
                    origin: origin,
                    grantID: staged.grantID,
                    stagingCredential: staged.stagingCredential,
                    authorizationHeaders: joinHeaders
                )
            } catch let error as MeshWatchClientError {
                throw mapClientError(error)
            }
        }

        let finalizeURL = URL(string: origin.value + "/api/v1/mailbox/watch/grants/\(staged.grantID.value)/finalize")!
        let finalizeHeaders = try await auth.authorizationHeaders(for: actorProfile, method: "POST", url: finalizeURL)
        let finalized: FinalizedWatchGrant
        do {
            finalized = try await client.finalizeGrant(
                origin: origin,
                grantID: staged.grantID,
                stagingCredential: staged.stagingCredential,
                authorizationHeaders: finalizeHeaders
            )
        } catch let error as MeshWatchClientError {
            throw mapClientError(error)
        }

        let binding = WatchGrantBinding(
            installationID: installationID,
            origin: origin,
            grantID: finalized.grantID,
            agentIDs: agentIDs,
            watchCredential: finalized.watchCredential,
            audience: finalized.audience,
            purpose: finalized.purpose
        )
        do {
            if existing == nil {
                try store.create(binding)
            } else {
                try store.replace(binding, confirmation: .confirmed)
            }
        } catch WatchGrantStoreError.interactionNotAllowed, WatchGrantStoreError.keychainFailure {
            try? await client.revokeGrant(origin: origin, watchCredential: finalized.watchCredential)
            throw WatchGrantServiceError.keychainUnavailable
        } catch {
            try? await client.revokeGrant(origin: origin, watchCredential: finalized.watchCredential)
            throw WatchGrantServiceError.keychainUnavailable
        }
        return status(from: binding)
    }

    public func status(installationID: InstallationID) throws -> WatchGrantOperatorStatus {
        do {
            return status(from: try store.read(for: installationID))
        } catch WatchGrantStoreError.itemNotFound {
            return WatchGrantOperatorStatus(
                installationID: installationID.value,
                origin: nil,
                grantID: nil,
                agentIDs: [],
                state: "missing",
                audience: nil,
                purpose: nil
            )
        } catch WatchGrantStoreError.interactionNotAllowed, WatchGrantStoreError.keychainFailure {
            throw WatchGrantServiceError.keychainUnavailable
        } catch {
            throw WatchGrantServiceError.keychainUnavailable
        }
    }

    public func revoke(installationID: InstallationID) async throws -> WatchGrantOperatorStatus {
        let binding: WatchGrantBinding
        do {
            binding = try store.read(for: installationID)
        } catch WatchGrantStoreError.itemNotFound {
            throw WatchGrantServiceError.credentialMissing
        } catch WatchGrantStoreError.interactionNotAllowed, WatchGrantStoreError.keychainFailure {
            throw WatchGrantServiceError.keychainUnavailable
        } catch {
            throw WatchGrantServiceError.keychainUnavailable
        }
        do {
            try await client.revokeGrant(origin: binding.origin, watchCredential: binding.watchCredential)
        } catch let error as MeshWatchClientError {
            throw mapClientError(error)
        }
        do {
            try store.delete(for: installationID)
        } catch WatchGrantStoreError.itemNotFound {
            // Already gone locally after remote revoke.
        } catch WatchGrantStoreError.interactionNotAllowed, WatchGrantStoreError.keychainFailure {
            throw WatchGrantServiceError.keychainUnavailable
        } catch {
            throw WatchGrantServiceError.keychainUnavailable
        }
        return WatchGrantOperatorStatus(
            installationID: installationID.value,
            origin: binding.origin.value,
            grantID: binding.grantID.value,
            agentIDs: binding.agentIDs.map(\.value),
            state: "revoked",
            audience: binding.audience,
            purpose: binding.purpose,
            operatorAction: .ensureWatchGrant
        )
    }

    public func poll(installationID: InstallationID, cursor: Int) async throws -> WatchPollResponse {
        guard cursor >= 0 else { throw WatchGrantServiceError.invalidCursor }
        let binding: WatchGrantBinding
        do {
            binding = try store.read(for: installationID)
        } catch WatchGrantStoreError.itemNotFound {
            throw WatchGrantServiceError.credentialMissing
        } catch WatchGrantStoreError.interactionNotAllowed, WatchGrantStoreError.keychainFailure {
            throw WatchGrantServiceError.keychainUnavailable
        } catch {
            throw WatchGrantServiceError.keychainUnavailable
        }
        do {
            return try await client.poll(
                origin: binding.origin,
                watchCredential: binding.watchCredential,
                cursor: cursor
            )
        } catch let error as MeshWatchClientError {
            throw mapClientError(error)
        }
    }

    private struct MemberBinding: Sendable {
        let profile: ProfileName
        let agentID: AgentID
    }

    private func resolveMembers(actorProfile: ProfileName, memberProfiles: [ProfileName]?) async throws -> [MemberBinding] {
        let profiles: [ProfileName]
        if let memberProfiles {
            profiles = memberProfiles
        } else if let instanceStore {
            let instances: [ClientInstance]
            do {
                instances = try instanceStore.list()
            } catch let error as ClientInstanceStoreError {
                throw error
            } catch {
                throw ClientInstanceStoreError.unsafeStorage
            }
            // Auto membership: event-driven drains + App Server-bound
            // mcp-interactive + Grok Bot-bound hosts (when bindings are present).
            // Do not pull every mcp-interactive / grok-bot profile into the grant.
            let eventDriven = instances.filter(\.participatesInEventDrivenWake)
            let boundInteractive = Self.appServerBoundInteractiveMembers(from: instances)
            let boundGrokBot = Self.grokBotBoundMembers(from: instances)
            profiles = (eventDriven + boundInteractive + boundGrokBot).map(\.profile)
        } else {
            profiles = [actorProfile]
        }
        guard !profiles.isEmpty else { throw WatchGrantServiceError.noEventDrivenMembers }
        guard profiles.contains(actorProfile) else { throw WatchGrantServiceError.actorNotDeclared }

        if let instanceStore {
            let actorInstance: ClientInstance
            do {
                actorInstance = try instanceStore.read(profile: actorProfile)
            } catch let error as ClientInstanceStoreError {
                throw error
            } catch {
                throw ClientInstanceStoreError.unsafeStorage
            }
            // mcp-interactive App Server hosts are notify-only; they cannot act.
            // grok-bot may act (Bob owns post-wake claim/reply/ack outside this adapter).
            if actorInstance.deliveryMode == .mcpInteractive {
                throw WatchGrantServiceError.interactiveDeliveryExcluded
            }
        }

        var members: [MemberBinding] = []
        for profile in profiles.sorted(by: { $0.value < $1.value }) {
            if let instanceStore {
                let instance: ClientInstance
                do {
                    instance = try instanceStore.read(profile: profile)
                } catch let error as ClientInstanceStoreError {
                    throw error
                } catch {
                    throw ClientInstanceStoreError.unsafeStorage
                }
                guard instance.participatesInWatchGrantNotify else {
                    throw WatchGrantServiceError.noEventDrivenMembers
                }
            }
            let credential = try await credentialGate.credential(for: profile)
            members.append(MemberBinding(profile: profile, agentID: credential.binding.agentID))
        }
        return members
    }

    private func status(from binding: WatchGrantBinding) -> WatchGrantOperatorStatus {
        WatchGrantOperatorStatus(
            installationID: binding.installationID.value,
            origin: binding.origin.value,
            grantID: binding.grantID.value,
            agentIDs: binding.agentIDs.map(\.value),
            state: "finalized",
            audience: binding.audience,
            purpose: binding.purpose
        )
    }

    /// When MESH rejects create-with-replacement because the local watch secret is
    /// stale/revoked, discard the local binding and retry create-without-replacement
    /// once. Status alone can look finalized while the on-disk credential is dead.
    private func createGrantRecoveringStaleLocalBinding(
        installationID: InstallationID,
        origin: MeshOrigin,
        agentIDs: [AgentID],
        authorizationHeaders: [String: String],
        replacementCredential: WatchCredential?,
        localBindingPresent: inout WatchGrantBinding?
    ) async throws -> StagedWatchGrant {
        do {
            return try await client.createGrant(
                origin: origin,
                installationID: installationID,
                agentIDs: agentIDs,
                authorizationHeaders: authorizationHeaders,
                replacementCredential: replacementCredential
            )
        } catch let error as MeshWatchClientError {
            guard
                replacementCredential != nil,
                Self.isStaleReplacementRejection(error)
            else {
                throw mapClientError(error)
            }
            try discardLocalWatchBinding(installationID: installationID)
            localBindingPresent = nil
            do {
                return try await client.createGrant(
                    origin: origin,
                    installationID: installationID,
                    agentIDs: agentIDs,
                    authorizationHeaders: authorizationHeaders,
                    replacementCredential: nil
                )
            } catch let retryError as MeshWatchClientError {
                throw mapClientError(retryError)
            }
        }
    }

    private func discardLocalWatchBinding(installationID: InstallationID) throws {
        do {
            try store.delete(for: installationID)
        } catch WatchGrantStoreError.itemNotFound {
            // Already gone locally.
        } catch WatchGrantStoreError.interactionNotAllowed, WatchGrantStoreError.keychainFailure {
            throw WatchGrantServiceError.keychainUnavailable
        } catch {
            throw WatchGrantServiceError.keychainUnavailable
        }
    }

    private static func isStaleReplacementRejection(_ error: MeshWatchClientError) -> Bool {
        guard case .rejected(_, let code) = error else { return false }
        return code == "replacement_unauthorized" || code == "watch_credential_invalid"
    }

    private func mapClientError(_ error: MeshWatchClientError) -> WatchGrantServiceError {
        switch error {
        case .resyncRequired(let restartCursor):
            .resyncRequired(restartCursor: restartCursor)
        case .rejected(let statusCode, let code):
            .rejected(statusCode: statusCode, code: code)
        case .workloadAuthRequired:
            .workloadAuthUnavailable
        case .transportUnavailable, .plaintextOrigin:
            .helperUnavailable
        default:
            .invalidResponse
        }
    }

    /// mcp-interactive profiles whose instanceId matches the durable App Server binding.
    private static func appServerBoundInteractiveMembers(from instances: [ClientInstance]) -> [ClientInstance] {
        let interactive = instances.filter(\.participatesInAppServerWake)
        guard !interactive.isEmpty else { return [] }
        let home = FileManager.default.homeDirectoryForCurrentUser
        let bindingURL = home
            .appendingPathComponent("Library/Application Support/The Triangle/client/app-server-binding.json")
        guard FileManager.default.isReadableFile(atPath: bindingURL.path),
              let data = try? Data(contentsOf: bindingURL),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let boundInstanceId = object["instanceId"] as? String,
              !boundInstanceId.isEmpty
        else { return [] }
        return interactive.filter { $0.instanceID.value == boundInstanceId }
    }

    /// grok-bot profiles whose instanceId matches the durable Grok Bot wake binding.
    private static func grokBotBoundMembers(from instances: [ClientInstance]) -> [ClientInstance] {
        let grokBots = instances.filter(\.participatesInGrokBotWake)
        guard !grokBots.isEmpty else { return [] }
        let home = FileManager.default.homeDirectoryForCurrentUser
        let bindingURL = home
            .appendingPathComponent("Library/Application Support/The Triangle/client/grok-bot-binding.json")
        guard FileManager.default.isReadableFile(atPath: bindingURL.path),
              let data = try? Data(contentsOf: bindingURL),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let boundInstanceId = object["instanceId"] as? String,
              !boundInstanceId.isEmpty
        else { return [] }
        return grokBots.filter { $0.instanceID.value == boundInstanceId }
    }
}

/// Production auth provider that mints DPoP-bound workload headers from Keychain-backed workload keys.
public struct WorkloadWatchGrantAuthProvider: WatchGrantAuthProviding {
    private let gate: VerifiedCredentialGate
    private let workloadKeyStore: any WorkloadKeyStore
    private let transport: any MeshTransport

    public init(
        gate: VerifiedCredentialGate,
        workloadKeyStore: any WorkloadKeyStore,
        transport: any MeshTransport
    ) {
        self.gate = gate
        self.workloadKeyStore = workloadKeyStore
        self.transport = transport
    }

    public func authorizationHeaders(for profile: ProfileName, method: String, url: URL) async throws -> [String: String] {
        let credential = try await gate.credential(for: profile)
        let record: WorkloadKeyRecord
        do {
            record = try workloadKeyStore.read(for: profile)
        } catch WorkloadKeyStoreError.itemNotFound {
            throw WatchGrantServiceError.workloadKeyMissing
        } catch WorkloadKeyStoreError.interactionNotAllowed, WorkloadKeyStoreError.keychainFailure {
            throw WatchGrantServiceError.keychainUnavailable
        } catch {
            throw WatchGrantServiceError.workloadAuthUnavailable
        }
        guard record.workloadID != nil else {
            throw WatchGrantServiceError.workloadKeyMissing
        }
        let manager: WorkloadTokenManager
        do {
            manager = try WorkloadTokenManager(
                origin: credential.origin,
                workloadRecord: record,
                transport: transport
            )
        } catch {
            throw WatchGrantServiceError.workloadAuthUnavailable
        }
        do {
            return try await manager.authorizationHeaders(method: method, url: url)
        } catch {
            throw WatchGrantServiceError.workloadAuthUnavailable
        }
    }
}
