import Testing
import TriangleMailboxTestSupport

@Suite("Authenticated local MCP companion")
struct MCPProxyTests {
    @Test("valid MCP methods forward sequentially") func validMethods() async throws { try await MCPProxyContractCases.validMethodsAndSequentialTurns() }
    @Test("registration and local mutation are rejected") func forbiddenOperations() async throws { try await MCPProxyContractCases.forbiddenLocalOperations() }
    @Test("MCP notifications preserve lifecycle semantics") func notifications() async throws { try await MCPProxyContractCases.notificationLifecycle() }
    @Test("invalid and oversized input never forwards") func invalidInput() async throws { try await MCPProxyContractCases.invalidInput() }
    @Test("duplicate JSON members fail closed") func duplicateMembers() async throws { try await MCPProxyContractCases.duplicateMembers() }
    @Test("invalid remote envelopes fail closed") func invalidRemote() async throws { try await MCPProxyContractCases.invalidRemoteResponses() }
    @Test("reflected bearer terminates without partial leak") func reflection() async throws { try await MCPProxyContractCases.reflectedBearer() }
    @Test("durable profile resumes in a fresh proxy") func resume() async throws { try await MCPProxyContractCases.freshProxyResume() }
    @Test("ineligible gates never forward MCP") func gateFailures() async throws { try await MCPProxyContractCases.gateFailuresNeverForward() }
    @Test("URLSession supports the MCP forwarding contract") func urlSession() async throws { try await MCPProxyContractCases.urlSessionMCPContract() }
    @Test("workload JWT and DPoP when key present") func workloadAuth() async throws { try await MCPProxyContractCases.workloadJWTAndDPoP() }
}
