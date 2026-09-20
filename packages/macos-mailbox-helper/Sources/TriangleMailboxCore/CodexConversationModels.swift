import Foundation

public enum CodexRuntimeOwnershipState: String, Codable, CaseIterable, Sendable {
    case owned
    case transferring
}

public enum CodexRuntimeMode: String, Codable, CaseIterable, Sendable {
    case headless
    case desktop
}

public enum CodexExecutionState: String, Codable, CaseIterable, Sendable {
    case idle
    case admitted
    case running
    case resultReady = "result_ready"
    case replyPersisted = "reply_persisted"
    case acked
}

public struct CodexProfileOwnerRecord: Codable, Equatable, Sendable {
    public let version: Int
    public let profileInstanceID: ClientInstanceID
    public let runtimeMode: CodexRuntimeMode
    public let ownerInstanceID: String
    public let ownerGeneration: Int
    public let ownershipState: CodexRuntimeOwnershipState
    public let leaseRenewedAt: String
    public let leaseExpiresAt: String
    public let activeMeshRoomID: String?
    public let updatedAt: String

    private enum CodingKeys: String, CodingKey {
        case version
        case profileInstanceID = "profile_instance_id"
        case runtimeMode = "runtime_mode"
        case ownerInstanceID = "owner_instance_id"
        case ownerGeneration = "owner_generation"
        case ownershipState = "ownership_state"
        case leaseRenewedAt = "lease_renewed_at"
        case leaseExpiresAt = "lease_expires_at"
        case activeMeshRoomID = "active_mesh_room_id"
        case updatedAt = "updated_at"
    }

    public init(
        version: Int = 1,
        profileInstanceID: ClientInstanceID,
        runtimeMode: CodexRuntimeMode,
        ownerInstanceID: String,
        ownerGeneration: Int,
        ownershipState: CodexRuntimeOwnershipState,
        leaseRenewedAt: String,
        leaseExpiresAt: String,
        activeMeshRoomID: String?,
        updatedAt: String
    ) {
        self.version = version
        self.profileInstanceID = profileInstanceID
        self.runtimeMode = runtimeMode
        self.ownerInstanceID = ownerInstanceID
        self.ownerGeneration = ownerGeneration
        self.ownershipState = ownershipState
        self.leaseRenewedAt = leaseRenewedAt
        self.leaseExpiresAt = leaseExpiresAt
        self.activeMeshRoomID = activeMeshRoomID
        self.updatedAt = updatedAt
    }
}

public struct CodexConversationRecord: Codable, Equatable, Sendable {
    public let version: Int
    public let profileInstanceID: ClientInstanceID
    public let meshRoomID: String
    public let codexThreadID: String
    public let activeDeliveryID: Int?
    public let executionEpoch: Int
    public let executionState: CodexExecutionState
    public let lastWorkerSlotID: String?
    public let lastCompletedDeliveryID: Int?
    public let lastReplyEventID: String?
    public let updatedAt: String

    private enum CodingKeys: String, CodingKey {
        case version
        case profileInstanceID = "profile_instance_id"
        case meshRoomID = "mesh_room_id"
        case codexThreadID = "codex_thread_id"
        case activeDeliveryID = "active_delivery_id"
        case executionEpoch = "execution_epoch"
        case executionState = "execution_state"
        case lastWorkerSlotID = "last_worker_slot_id"
        case lastCompletedDeliveryID = "last_completed_delivery_id"
        case lastReplyEventID = "last_reply_event_id"
        case updatedAt = "updated_at"
    }

    public init(
        version: Int = 1,
        profileInstanceID: ClientInstanceID,
        meshRoomID: String,
        codexThreadID: String,
        activeDeliveryID: Int?,
        executionEpoch: Int,
        executionState: CodexExecutionState,
        lastWorkerSlotID: String?,
        lastCompletedDeliveryID: Int?,
        lastReplyEventID: String?,
        updatedAt: String
    ) {
        self.version = version
        self.profileInstanceID = profileInstanceID
        self.meshRoomID = meshRoomID
        self.codexThreadID = codexThreadID
        self.activeDeliveryID = activeDeliveryID
        self.executionEpoch = executionEpoch
        self.executionState = executionState
        self.lastWorkerSlotID = lastWorkerSlotID
        self.lastCompletedDeliveryID = lastCompletedDeliveryID
        self.lastReplyEventID = lastReplyEventID
        self.updatedAt = updatedAt
    }
}

public struct CodexCompletionRecord: Codable, Equatable, Sendable {
    public let version: Int
    public let profileInstanceID: ClientInstanceID
    public let meshRoomID: String
    public let idempotencyID: String
    public let deliveryID: Int
    public let replyEventID: String
    public let completedAt: String

    private enum CodingKeys: String, CodingKey {
        case version
        case profileInstanceID = "profile_instance_id"
        case meshRoomID = "mesh_room_id"
        case idempotencyID = "idempotency_id"
        case deliveryID = "delivery_id"
        case replyEventID = "reply_event_id"
        case completedAt = "completed_at"
    }

    public init(
        version: Int = 1,
        profileInstanceID: ClientInstanceID,
        meshRoomID: String,
        idempotencyID: String,
        deliveryID: Int,
        replyEventID: String,
        completedAt: String
    ) {
        self.version = version
        self.profileInstanceID = profileInstanceID
        self.meshRoomID = meshRoomID
        self.idempotencyID = idempotencyID
        self.deliveryID = deliveryID
        self.replyEventID = replyEventID
        self.completedAt = completedAt
    }
}
