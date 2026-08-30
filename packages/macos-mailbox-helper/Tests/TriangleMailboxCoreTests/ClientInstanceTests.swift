import Testing
import TriangleMailboxTestSupport

@Suite("Triangle Client instance registry")
struct ClientInstanceTests {
    @Test("instance IDs are deterministic full framed SHA-256 digests")
    func identityDerivation() throws { try ClientInstanceContractCases.identityDerivation() }

    @Test("instances round trip and list deterministically")
    func createReadAndOrdering() throws { try ClientInstanceContractCases.createReadAndOrdering() }

    @Test("a profile cannot be duplicated or rebound")
    func duplicateAndCrossRuntimeRefusal() throws { try ClientInstanceContractCases.duplicateAndCrossRuntimeRefusal() }

    @Test("records use a strict schema and recomputed identity")
    func strictSchemaAndIdentifierValidation() throws { try ClientInstanceContractCases.strictSchemaAndIdentifierValidation() }

    @Test("records are atomically stored in safe private paths")
    func safeAtomicStorage() throws { try ClientInstanceContractCases.safeAtomicStorage() }

    @Test("duplicate JSON members fail closed before decoding")
    func duplicateMemberRefusal() throws { try ClientInstanceContractCases.duplicateMemberRefusal() }

    @Test("exclusive atomic create survives pre- and post-commit crashes")
    func atomicCreateCrashRecovery() throws { try ClientInstanceContractCases.atomicCreateCrashRecovery() }

    @Test("create, enable, disable, and remove transitions are serialized")
    func serializedTransitions() throws { try ClientInstanceContractCases.serializedTransitions() }

    @Test("unsafe ownership and permissions fail closed")
    func unsafeMetadataRefusal() throws { try ClientInstanceContractCases.unsafeMetadataRefusal() }

    @Test("lifecycle operations target one profile and preserve credentials")
    func exactLifecycleAndCredentialPreservation() throws { try ClientInstanceContractCases.exactLifecycleAndCredentialPreservation() }
}
