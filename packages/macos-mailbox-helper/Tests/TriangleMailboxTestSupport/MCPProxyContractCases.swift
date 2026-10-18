import CryptoKit
import Foundation
import TriangleMailboxCore

public enum MCPProxyContractCases {
    public struct ContractCase: Sendable {
        public let name: String
        public let run: @Sendable () async throws -> Void
    }

    static let agent = try! V1TestCustody.memoryAgent(profile: "codex-mailbox-live", handle: "codex-mailbox-live", fill: "b")
    /// The secret canary: this agent's workload key seed (never crosses the MCP channel).
    private static var token: String { agent.seed }
    private static var agentID: String { agent.agentID.value }

    public static let all: [ContractCase] = [
        .init(name: "valid MCP methods forward sequentially", run: validMethodsAndSequentialTurns),
        .init(name: "registration and local mutation are rejected", run: forbiddenLocalOperations),
        .init(name: "MCP notifications preserve lifecycle semantics", run: notificationLifecycle),
        .init(name: "invalid and oversized input never forwards", run: invalidInput),
        .init(name: "duplicate JSON members fail closed", run: duplicateMembers),
        .init(name: "invalid remote envelopes fail closed", run: invalidRemoteResponses),
        .init(name: "reflected bearer terminates without partial leak", run: reflectedBearer),
        .init(name: "durable profile resumes in a fresh proxy", run: freshProxyResume),
        .init(name: "ineligible gates never forward MCP", run: gateFailuresNeverForward),
        .init(name: "URLSession transport is valid for MCP forwarding", run: urlSessionMCPContract),
        .init(name: "workload access token and DPoP on every MCP request", run: workloadJWTAndDPoP),
        .init(name: "reflected workload access token terminates", run: reflectedAccessToken),
    ]

    public static func validMethodsAndSequentialTurns() async throws {
        let requests = [
            #"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1"}}}"#,
            #"{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}"#,
            #"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"mesh.mailbox.list","arguments":{"limit":10}}}"#,
        ]
        let responses = [
            #"{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-03-26","capabilities":{},"serverInfo":{"name":"mesh","version":"1"}}}"#,
            #"{"jsonrpc":"2.0","id":2,"result":{"tools":[]}}"#,
            #"{"jsonrpc":"2.0","id":3,"result":{"content":[]}}"#,
        ]
        let transport = RecordingProxyTransport(identityAndMCP: responses.map(jsonResponse))
        let output = BufferProxyOutput()
        let result = await proxy(transport: transport).run(
            profile: try ProfileName("codex-mailbox-live"),
            input: Data((requests.joined(separator: "\n") + "\n").utf8),
            output: output
        )

        try expect(result == .completed, "valid sequential session did not complete")
        try expect(output.stdout == Data((responses.joined(separator: "\n") + "\n").utf8), "responses were not forwarded unchanged")
        try expect(output.stderr.isEmpty, "valid session wrote diagnostics")
        try expect(
            transport.requests.prefix(3).map(\.url.absoluteString) == [
                "https://thetriangle.dev/api/v1/identity/token-challenges",
                "https://thetriangle.dev/api/v1/identity/tokens",
                "https://thetriangle.dev/api/v1/agents/me",
            ],
            "proxy skipped the fresh workload identity check"
        )
        let forwarded = transport.requests.filter { $0.url.path == "/api/mcp" }
        try expect(forwarded.count == 3, "sequential MCP requests were not all forwarded")
        for (index, request) in forwarded.enumerated() {
            try expect(request.url.absoluteString == "https://thetriangle.dev/api/mcp", "proxy changed the bound MCP endpoint")
            try expect(transport.mesh.workload(forAuthorization: request.headers) == agent.workloadID.value, "proxy did not attach the workload access token and DPoP")
            try expect(request.body == Data(requests[index].utf8), "proxy changed a valid request")
        }
    }

    public static func forbiddenLocalOperations() async throws {
        let admissionCanary = "admission_do_not_forward"
        let issuedBearerCanary = "mesh_" + String(repeating: "e", count: 64)
        let cases: [(String, Int?)] = [
            (#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"mesh.mailbox.register","arguments":{"admissionToken":"\#(admissionCanary)"}}}"#, 1),
            (#"{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"mesh.registration_challenge","arguments":{"token":"\#(issuedBearerCanary)"}}}"#, 2),
            (#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"mesh.complete_registration","arguments":{"token":"\#(issuedBearerCanary)"}}}"#, 3),
            (#"{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"triangle.local.profile.replace","arguments":{}}}"#, 4),
            (#"{"jsonrpc":"2.0","method":"tools/call","params":{"name":"mesh.complete_registration","arguments":{"token":"\#(issuedBearerCanary)"}}}"#, nil),
            (#"{"jsonrpc":"2.0","method":"triangle.local.credential.delete","params":{}}"#, nil),
        ]
        for (request, expectedID) in cases {
            let transport = RecordingProxyTransport(identityAndMCP: [])
            let output = BufferProxyOutput()
            let result = await proxy(transport: transport).run(profile: try ProfileName("codex-mailbox-live"), input: Data("\(request)\n".utf8), output: output)
            try expect(result == .completed, "local policy rejection killed the session")
            try expect(transport.requests.isEmpty, "forbidden local operation reached transport")
            if let expectedID {
                try expect(output.stdoutJSONRPCErrorCode == -32601, "forbidden operation did not return method-not-found")
                try expect(output.stdoutJSONRPCID == expectedID, "forbidden request did not preserve its JSON-RPC id")
            } else {
                try expect(output.stdout.isEmpty && output.stderr.isEmpty, "forbidden notification emitted output")
            }
            let rendered = String(decoding: output.stdout + output.stderr, as: UTF8.self)
            try expect(!rendered.contains(admissionCanary) && !rendered.contains(issuedBearerCanary), "registration material appeared in policy output")
            try assertSecretFree(output)
        }
    }

    public static func notificationLifecycle() async throws {
        let initializeRequest = #"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1"}}}"#
        let initializedNotification = #"{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}"#
        let listRequest = #"{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}"#
        let initializeResponse = #"{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-03-26","capabilities":{},"serverInfo":{"name":"mesh","version":"1"}}}"#
        let listResponse = #"{"jsonrpc":"2.0","id":2,"result":{"tools":[]}}"#
        let acceptedNotification = MeshHTTPResponse(
            statusCode: 202, headers: [:], body: Data(),
            finalURL: URL(string: "https://thetriangle.dev/api/mcp")!
        )
        let transport = RecordingProxyTransport(identityAndMCP: [
            jsonResponse(initializeResponse), acceptedNotification, jsonResponse(listResponse),
        ])
        let output = BufferProxyOutput()
        let input = Data(([initializeRequest, initializedNotification, listRequest].joined(separator: "\n") + "\n").utf8)
        let result = await proxy(transport: transport).run(profile: try ProfileName("codex-mailbox-live"), input: input, output: output)
        try expect(result == .completed, "notification lifecycle did not complete")
        try expect(output.stdout == Data("\(initializeResponse)\n\(listResponse)\n".utf8), "notification emitted output or disrupted sequence")
        try expect(output.stderr.isEmpty, "valid notification emitted diagnostics")
        let forwarded = transport.mcpRequests
        try expect(forwarded.count == 3 && forwarded[1].body == Data(initializedNotification.utf8), "initialized notification was not forwarded sequentially")

        let invalidNotificationResponses = [
            MeshHTTPResponse(statusCode: 202, headers: ["Content-Type": "application/json"], body: Data("{}".utf8), finalURL: URL(string: "https://thetriangle.dev/api/mcp")!),
            MeshHTTPResponse(statusCode: 200, headers: ["Content-Type": "application/json"], body: Data(#"{"jsonrpc":"2.0","id":null,"result":{}}"#.utf8), finalURL: URL(string: "https://thetriangle.dev/api/mcp")!),
            MeshHTTPResponse(statusCode: 204, headers: [:], body: Data(), finalURL: URL(string: "https://thetriangle.dev/api/mcp")!),
        ]
        for response in invalidNotificationResponses {
            let invalidTransport = RecordingProxyTransport(identityAndMCP: [response])
            let invalidOutput = BufferProxyOutput()
            let invalidResult = await proxy(transport: invalidTransport).run(
                profile: try ProfileName("codex-mailbox-live"), input: Data("\(initializedNotification)\n".utf8), output: invalidOutput
            )
            try expect(invalidResult == .completed, "invalid notification response crashed session")
            try expect(invalidOutput.stdout.isEmpty && invalidOutput.stderr.isEmpty, "notification failure synthesized output")
        }
    }

    public static func invalidInput() async throws {
        // A legacy bearer-shaped id is refused before any credential is touched.
        let tokenAsIdLine = "{\"jsonrpc\":\"2.0\",\"id\":\"mesh_\(String(repeating: "d", count: 64))\",\"method\":\"tools/list\"}\n"
        let oversized = Data(repeating: 0x61, count: MCPProxy.maximumMessageBytes + 1) + Data("\n".utf8)
        let cases: [Data] = [
            Data("not-json\n".utf8),
            Data("[]\n".utf8),
            Data(#"{"jsonrpc":"1.0","id":1,"method":"tools/list"}"#.utf8) + Data("\n".utf8),
            Data(#"{"jsonrpc":"2.0","id":{},"method":"tools/list"}"#.utf8) + Data("\n".utf8),
            Data(#"{"jsonrpc":"2.0","id":1,"method":"tools/list","origin":"https://evil.example"}"#.utf8) + Data("\n".utf8),
            Data(#"{"jsonrpc":"2.0","id":1,"method":"tools/list","token":"mesh_override"}"#.utf8) + Data("\n".utf8),
            Data(#"{"jsonrpc":"2.0","id":1,"method":"tools/list","agentId":"agent_override"}"#.utf8) + Data("\n".utf8),
            Data(tokenAsIdLine.utf8),
            oversized,
        ]
        for input in cases {
            let transport = RecordingProxyTransport(identityAndMCP: [])
            let output = BufferProxyOutput()
            _ = await proxy(transport: transport).run(profile: try ProfileName("codex-mailbox-live"), input: input, output: output)
            try expect(transport.requests.isEmpty, "invalid local input reached even the credential gate")
            try assertSecretFree(output)
        }
    }

    public static func invalidRemoteResponses() async throws {
        let validRequest = Data(#"{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}"#.utf8)
        let cases: [MeshHTTPResponse] = [
            MeshHTTPResponse(statusCode: 302, headers: ["Content-Type": "application/json"], body: Data(#"{"jsonrpc":"2.0","id":1,"result":{}}"#.utf8), finalURL: URL(string: "https://thetriangle.dev/api/mcp")!),
            MeshHTTPResponse(statusCode: 200, headers: ["Content-Type": "text/plain"], body: Data(#"{"jsonrpc":"2.0","id":1,"result":{}}"#.utf8), finalURL: URL(string: "https://thetriangle.dev/api/mcp")!),
            MeshHTTPResponse(statusCode: 200, headers: ["Content-Type": "application/json"], body: Data(#"{"jsonrpc":"2.0","id":1,"result":{}}"#.utf8), finalURL: URL(string: "https://evil.example/api/mcp")!),
            MeshHTTPResponse(statusCode: 200, headers: ["Content-Type": "application/json"], body: Data(repeating: 0x20, count: MCPProxy.maximumResponseBytes + 1), finalURL: URL(string: "https://thetriangle.dev/api/mcp")!),
            MeshHTTPResponse(statusCode: 200, headers: ["Content-Type": "application/json"], body: Data("not-json".utf8), finalURL: URL(string: "https://thetriangle.dev/api/mcp")!),
            MeshHTTPResponse(statusCode: 200, headers: ["Content-Type": "application/json"], body: Data(#"{"jsonrpc":"1.0","id":1,"result":{}}"#.utf8), finalURL: URL(string: "https://thetriangle.dev/api/mcp")!),
            MeshHTTPResponse(statusCode: 200, headers: ["Content-Type": "application/json"], body: Data(#"{"jsonrpc":"2.0","id":1,"error":"wrong-shape"}"#.utf8), finalURL: URL(string: "https://thetriangle.dev/api/mcp")!),
        ]
        for response in cases {
            let transport = RecordingProxyTransport(identityAndMCP: [response])
            let output = BufferProxyOutput()
            let result = await proxy(transport: transport).run(profile: try ProfileName("codex-mailbox-live"), input: validRequest + Data("\n".utf8), output: output)
            try expect(result == .completed, "ordinary invalid remote response terminated session")
            try expect(output.stdoutJSONRPCErrorCode == -32603, "invalid remote response was forwarded")
            try assertSecretFree(output)
        }
    }

    public static func duplicateMembers() async throws {
        let duplicateInputs = [
            #"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"mesh.complete_registration","name":"mesh.mailbox.list","arguments":{}}}"#,
            #"{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"na\u006de":"mesh.complete_registration","name":"mesh.mailbox.list","arguments":{}}}"#,
        ]
        for input in duplicateInputs {
            let transport = RecordingProxyTransport(identityAndMCP: [])
            let output = BufferProxyOutput()
            _ = await proxy(transport: transport).run(
                profile: try ProfileName("codex-mailbox-live"), input: Data("\(input)\n".utf8), output: output
            )
            try expect(transport.requests.isEmpty, "duplicate input reached transport")
            try expect(output.stdoutJSONRPCErrorCode == -32600, "duplicate input was not rejected as invalid")
            try assertSecretFree(output)
        }

        let duplicateResponse = #"{"jsonrpc":"2.0","id":1,"result":{"safe":true},"res\u0075lt":{"unsafe":true}}"#
        let responseTransport = RecordingProxyTransport(identityAndMCP: [jsonResponse(duplicateResponse)])
        let responseOutput = BufferProxyOutput()
        _ = await proxy(transport: responseTransport).run(
            profile: try ProfileName("codex-mailbox-live"),
            input: Data((#"{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}"# + "\n").utf8),
            output: responseOutput
        )
        try expect(responseOutput.stdoutJSONRPCErrorCode == -32603, "duplicate response was emitted")
        try assertSecretFree(responseOutput)
    }

    public static func reflectedBearer() async throws {
        let reflected = #"{"jsonrpc":"2.0","id":1,"result":{"message":"\#(token)"}}"#
        let transport = RecordingProxyTransport(identityAndMCP: [jsonResponse(reflected)])
        let output = BufferProxyOutput()
        let input = Data((#"{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}"# + "\n" + #"{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}"# + "\n").utf8)
        let result = await proxy(transport: transport).run(profile: try ProfileName("codex-mailbox-live"), input: input, output: output)
        try expect(result == .terminatedForSecretInvariant, "reflected bearer did not terminate the session")
        try expect(transport.mcpRequests.count == 1, "proxy continued after remote token reflection")
        try expect(output.stdout.isEmpty, "proxy emitted partial reflected response")
        try expect(output.stderr == Data("{\"error\":\"credential_invariant_failed\"}\n".utf8), "reflection diagnostic was not exact and bounded")
        try assertSecretFree(output)

        let unavailable = RecordingProxyTransport(identityAndMCP: [])
        let localReflectionOutput = BufferProxyOutput()
        let localReflection = #"{"jsonrpc":"2.0","id":"Bearer \#(token)","method":"tools/list","params":{}}"#
        let localResult = await proxy(transport: unavailable).run(
            profile: try ProfileName("codex-mailbox-live"),
            input: Data("\(localReflection)\n".utf8),
            output: localReflectionOutput
        )
        try expect(localResult == .terminatedForSecretInvariant, "local diagnostic reflection did not terminate")
        try expect(localReflectionOutput.stdout.isEmpty, "local diagnostic partially leaked the bearer")
        try expect(localReflectionOutput.stderr == Data("{\"error\":\"credential_invariant_failed\"}\n".utf8), "local invariant diagnostic was not bounded")
        try assertSecretFree(localReflectionOutput)

        let inputTransport = RecordingProxyTransport(identityAndMCP: [])
        let inputOutput = BufferProxyOutput()
        let suppliedToken = #"{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"mesh.mailbox.list","arguments":{"token":"\#(token)"}}}"#
        let inputResult = await proxy(transport: inputTransport).run(
            profile: try ProfileName("codex-mailbox-live"),
            input: Data("\(suppliedToken)\n".utf8),
            output: inputOutput
        )
        try expect(inputResult == .terminatedForSecretInvariant, "caller-supplied bearer was accepted")
        try expect(inputTransport.mcpRequests.isEmpty, "caller-supplied bearer reached MESH")
        try assertSecretFree(inputOutput)

        let split = token.index(token.startIndex, offsetBy: 29)
        let first = String(token[..<split])
        let second = String(token[split...])
        let unicodeEscaped = token.unicodeScalars.map { String(format: "\\u%04x", $0.value) }.joined()
        let normalizedFixtures = [
            "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"message\":\"\(unicodeEscaped)\"}}",
            "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":[\"\(first)\",\"\(second)\"]}",
            "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"a\":\"Bearer \",\"b\":\"\(first)\",\"c\":\"\(second)\"}}",
            "{\"jsonrpc\":\"2.0\",\"id\":1,\"error\":{\"code\":-32000,\"message\":\"safe\",\"data\":[\"\(first)\",\"\(second)\"]}}",
            "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"\(unicodeEscaped)\":\"safe\"}}",
            "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"outer\":{\"\(first)\":\"\(second)\"}}}",
            "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"outer\":{\"lead\":\"\(first)\",\"\(second)\":\"safe\"}}}",
            "{\"jsonrpc\":\"2.0\",\"id\":1,\"error\":{\"code\":-32000,\"message\":\"safe\",\"data\":{\"\(first)\":\"\(second)\"}}}",
        ]
        for (fixtureIndex, fixture) in normalizedFixtures.enumerated() {
            let normalizedTransport = RecordingProxyTransport(identityAndMCP: [jsonResponse(fixture)])
            let normalizedOutput = BufferProxyOutput()
            let normalizedResult = await proxy(transport: normalizedTransport).run(
                profile: try ProfileName("codex-mailbox-live"),
                input: Data((#"{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}"# + "\n").utf8),
                output: normalizedOutput
            )
            try expect(normalizedResult == .terminatedForSecretInvariant, "normalized reflection fixture \(fixtureIndex) bypassed the guard")
            try expect(normalizedOutput.stdout.isEmpty, "normalized reflection emitted a partial response")
            let rendered = String(decoding: normalizedOutput.stdout + normalizedOutput.stderr, as: UTF8.self)
            try expect(!rendered.contains("mesh_") && !rendered.contains(first) && !rendered.contains(token), "normalized reflection emitted a secret prefix")
            try assertSecretFree(normalizedOutput)
        }

        let notificationReflection = MeshHTTPResponse(
            statusCode: 202, headers: ["Content-Type": "application/json"],
            body: Data("{\"reflected\":\"\(unicodeEscaped)\"}".utf8),
            finalURL: URL(string: "https://thetriangle.dev/api/mcp")!
        )
        let notificationTransport = RecordingProxyTransport(identityAndMCP: [notificationReflection])
        let notificationOutput = BufferProxyOutput()
        let notificationResult = await proxy(transport: notificationTransport).run(
            profile: try ProfileName("codex-mailbox-live"),
            input: Data((#"{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}"# + "\n").utf8),
            output: notificationOutput
        )
        try expect(notificationResult == .terminatedForSecretInvariant, "notification reflection did not terminate")
        try expect(notificationOutput.stdout.isEmpty && notificationOutput.stderr.isEmpty, "notification reflection emitted output")

        let notificationKeyReflection = MeshHTTPResponse(
            statusCode: 202, headers: ["Content-Type": "application/json"],
            body: Data("{\"\(unicodeEscaped)\":\"safe\"}".utf8),
            finalURL: URL(string: "https://thetriangle.dev/api/mcp")!
        )
        let notificationKeyTransport = RecordingProxyTransport(identityAndMCP: [notificationKeyReflection])
        let notificationKeyOutput = BufferProxyOutput()
        let notificationKeyResult = await proxy(transport: notificationKeyTransport).run(
            profile: try ProfileName("codex-mailbox-live"),
            input: Data((#"{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}"# + "\n").utf8),
            output: notificationKeyOutput
        )
        try expect(notificationKeyResult == .terminatedForSecretInvariant, "notification key reflection did not terminate")
        try expect(notificationKeyOutput.stdout.isEmpty && notificationKeyOutput.stderr.isEmpty, "notification key reflection emitted output")

        let inputKeyTransport = RecordingProxyTransport(identityAndMCP: [])
        let inputKeyOutput = BufferProxyOutput()
        let inputKey = "{\"jsonrpc\":\"2.0\",\"id\":5,\"method\":\"tools/call\",\"params\":{\"name\":\"mesh.mailbox.list\",\"arguments\":{\"\(unicodeEscaped)\":\"safe\"}}}"
        let inputKeyResult = await proxy(transport: inputKeyTransport).run(
            profile: try ProfileName("codex-mailbox-live"), input: Data("\(inputKey)\n".utf8), output: inputKeyOutput
        )
        try expect(inputKeyResult == .terminatedForSecretInvariant, "input credential key was accepted")
        try expect(inputKeyTransport.mcpRequests.isEmpty, "input credential key reached MESH")
        try expect(inputKeyOutput.stdout.isEmpty, "input credential key emitted stdout")
        try assertSecretFree(inputKeyOutput)
    }

    public static func freshProxyResume() async throws {
        let store = installedResolver()
        for id in [1, 2] {
            let response = #"{"jsonrpc":"2.0","id":\#(id),"result":{"tools":[]}}"#
            let transport = RecordingProxyTransport(identityAndMCP: [jsonResponse(response)])
            let output = BufferProxyOutput()
            let fresh = MCPProxy(gate: VerifiedCredentialGate(resolver: store, transport: transport), transport: transport)
            let result = await fresh.run(profile: try ProfileName("codex-mailbox-live"), input: Data((#"{"jsonrpc":"2.0","id":\#(id),"method":"tools/list","params":{}}"# + "\n").utf8), output: output)
            try expect(result == .completed && output.stdout == Data("\(response)\n".utf8), "fresh proxy failed to resume durable profile")
        }
    }

    public static func gateFailuresNeverForward() async throws {
        let profile = try ProfileName("codex-mailbox-live")
        let paused = RecordingProxyTransport(identityAndMCP: [])
        paused.mesh.update(agent.workloadID) { $0.state = "paused" }
        let refused = RecordingProxyTransport(identityAndMCP: [])
        refused.mesh.mode = .refuseTokens(code: "workload_forbidden", status: 403)
        let mismatch = RecordingProxyTransport(identityAndMCP: [])
        mismatch.mesh.update(agent.workloadID) { $0.reportedAgentID = "agent_" + String(repeating: "f", count: 32) }
        let scenarios: [(any V1AgentResolver, any MeshTransport, String)] = [
            (InMemoryV1AgentResolver(), RecordingProxyTransport(identityAndMCP: []), "profile_not_found"),
            (BrokenResolver(), RecordingProxyTransport(identityAndMCP: []), "credential_invalid"),
            (installedResolver(), paused, "agent_paused"),
            (installedResolver(), refused, "credential_refused"),
            (installedResolver(), mismatch, "identity_mismatch"),
            (installedResolver(), OfflineProxyTransport(), "identity_verification_offline"),
        ]
        for (store, transport, reason) in scenarios {
            let recording = transport as? RecordingProxyTransport
            let output = BufferProxyOutput()
            let instance = MCPProxy(gate: VerifiedCredentialGate(resolver: store, transport: transport), transport: transport)
            let result = await instance.run(profile: profile, input: Data((#"{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}"# + "\n").utf8), output: output)
            try expect(result == .failed, "ineligible gate did not fail the session (\(reason))")
            try expect(recording?.mcpRequests.isEmpty ?? true, "ineligible gate forwarded MCP")
            try expect(output.stderr == Data("{\"error\":\"\(reason)\"}\n".utf8), "gate diagnostic was not \(reason): \(String(decoding: output.stderr, as: UTF8.self))")
            try assertSecretFree(output)
        }
    }

    public static func workloadJWTAndDPoP() async throws {
        let mcpResponse = jsonResponse(#"{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}"#)
        let transport = RecordingProxyTransport(identityAndMCP: [mcpResponse])
        let output = BufferProxyOutput()
        let result = await proxy(transport: transport).run(
            profile: try ProfileName("codex-mailbox-live"),
            input: Data((#"{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}"# + "\n").utf8),
            output: output
        )
        try expect(result == .completed, "workload-auth MCP session did not complete")
        let mcpRequest = try requireValue(transport.mcpRequests.first, "MCP not forwarded")
        try expect(transport.mesh.workload(forAuthorization: mcpRequest.headers) == agent.workloadID.value, "MCP lacked the workload access token")
        let dpop = try requireValue(mcpRequest.headers["DPoP"], "MCP lacked DPoP")
        let parts = dpop.split(separator: ".").map(String.init)
        try expect(parts.count == 3, "DPoP is not a compact JWS")
        let payload = try JSONSerialization.jsonObject(with: Base64URL.decode(parts[1]) ?? Data()) as? [String: Any]
        try expect(payload?["htm"] as? String == "POST" && payload?["htu"] as? String == "https://thetriangle.dev/api/mcp", "DPoP not bound to the MCP request")
        try expect(payload?["ath"] is String, "DPoP not bound to the access token")
        let rendered = String(decoding: output.stdout + output.stderr, as: UTF8.self)
        for issued in transport.mesh.issuedTokens {
            try expect(!rendered.contains(issued), "workload token leaked to output")
        }
        try expect(!rendered.contains(token), "workload key leaked to output")
    }

    public static func reflectedAccessToken() async throws {
        let transport = RecordingProxyTransport(identityAndMCP: [jsonResponse(#"{"jsonrpc":"2.0","id":1,"result":{"message":"{{ACCESS_TOKEN}}"}}"#)])
        let output = BufferProxyOutput()
        let result = await proxy(transport: transport).run(
            profile: try ProfileName("codex-mailbox-live"),
            input: Data((#"{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}"# + "\n").utf8),
            output: output
        )
        try expect(result == .terminatedForSecretInvariant, "reflected access token did not terminate")
        try expect(output.stdout.isEmpty, "reflected access token was emitted")
        for issued in transport.mesh.issuedTokens {
            try expect(!String(decoding: output.stdout + output.stderr, as: UTF8.self).contains(issued), "access token leaked")
        }
    }

    public static func urlSessionMCPContract() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [MCPFixtureURLProtocol.self]
        MCPFixtureURLProtocol.reset([
            .init(status: 201, url: URL(string: "https://thetriangle.dev/api/v1/identity/token-challenges")!, headers: ["Content-Type": "application/json"], body: Data(#"{"challenge":{"challenge_id":"chal_1","principal_id":"\#(agentID)","audience":"https://thetriangle.dev","nonce":"n1"}}"#.utf8)),
            .init(status: 200, url: URL(string: "https://thetriangle.dev/api/v1/identity/tokens")!, headers: ["Content-Type": "application/json"], body: Data(#"{"access_token":"at_urlsession_fixture","token_type":"DPoP","expires_in":300}"#.utf8)),
            .init(status: 200, url: URL(string: "https://thetriangle.dev/api/v1/agents/me")!, headers: ["Content-Type": "application/json"], body: identityBody()),
            .init(status: 200, url: URL(string: "https://thetriangle.dev/api/mcp")!, headers: ["Content-Type": "application/json"], body: Data(#"{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}"#.utf8)),
        ])
        let transport = URLSessionMeshTransport(configuration: configuration)
        let output = BufferProxyOutput()
        let instance = MCPProxy(gate: VerifiedCredentialGate(resolver: installedResolver(), transport: transport), transport: transport)
        _ = await instance.run(profile: try ProfileName("codex-mailbox-live"), input: Data((#"{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}"# + "\n").utf8), output: output)
        let requests = MCPFixtureURLProtocol.requests
        try expect(requests.count == 4 && requests[3].url?.absoluteString == "https://thetriangle.dev/api/mcp", "URLSession did not use exact MCP URL")
        try expect(requests[3].value(forHTTPHeaderField: "Authorization") == "Bearer at_urlsession_fixture", "URLSession omitted the workload access token")
        try expect(requests[3].value(forHTTPHeaderField: "DPoP") != nil, "URLSession omitted DPoP")
        try assertSecretFree(output)
    }

    private static func proxy(transport: RecordingProxyTransport) -> MCPProxy {
        MCPProxy(gate: VerifiedCredentialGate(resolver: installedResolver(), transport: transport), transport: transport)
    }

    private static func installedResolver() -> InMemoryV1AgentResolver { V1TestCustody.resolver([agent]) }
    private static func requireValue<T>(_ value: T?, _ message: String) throws -> T { guard let value else { throw MCPContractFailure(message) }; return value }
    private static func identityBody() -> Data { Data(#"{"agent":{"id":"\#(agentID)","handle":"codex-mailbox-live"},"state":"active","permissions":{"dm_owner":true},"revision":1}"#.utf8) }
    private static func jsonResponse(_ body: String) -> MeshHTTPResponse { MeshHTTPResponse(statusCode: 200, headers: ["Content-Type": "application/json"], body: Data(body.utf8), finalURL: URL(string: "https://thetriangle.dev/api/mcp")!) }
    private static func expect(_ condition: @autoclosure () -> Bool, _ message: String) throws { guard condition() else { throw MCPContractFailure(message) } }
    private static func assertSecretFree(_ output: BufferProxyOutput) throws { try expect(!String(decoding: output.stdout + output.stderr, as: UTF8.self).contains(token), "proxy output exposed bearer") }
}

private struct MCPContractFailure: Error, CustomStringConvertible { let message: String; init(_ message: String) { self.message = message }; var description: String { message } }

/// Identity exchange goes to a fake v1 MESH; MCP requests pop scripted responses.
/// `{{ACCESS_TOKEN}}` in a scripted body is replaced with the live access token.
private final class RecordingProxyTransport: MeshTransport, @unchecked Sendable {
    let mesh = FakeV1Mesh(agents: [MCPProxyContractCases.agent])
    private let lock = NSLock(); private var responses: [MeshHTTPResponse]; private var captured: [MeshHTTPRequest] = []
    init(identityAndMCP responses: [MeshHTTPResponse]) { self.responses = responses }
    var requests: [MeshHTTPRequest] { lock.withLock { captured } }
    var mcpRequests: [MeshHTTPRequest] { requests.filter { $0.url.path == "/api/mcp" } }
    func send(_ request: MeshHTTPRequest) async throws -> MeshHTTPResponse {
        lock.withLock { captured.append(request) }
        if request.url.path.hasPrefix("/api/v1/identity/") || request.url.path == "/api/v1/agents/me" {
            return try await mesh.send(request)
        }
        let next: MeshHTTPResponse = try lock.withLock {
            guard !responses.isEmpty else { throw MeshClientError.transportUnavailable }
            return responses.removeFirst()
        }
        let live = request.headers["Authorization"].map { String($0.dropFirst("Bearer ".count)) } ?? ""
        let body = String(decoding: next.body, as: UTF8.self)
        guard body.contains("{{ACCESS_TOKEN}}") else { return next }
        return MeshHTTPResponse(statusCode: next.statusCode, headers: next.headers, body: Data(body.replacingOccurrences(of: "{{ACCESS_TOKEN}}", with: live).utf8), finalURL: next.finalURL)
    }
}

private struct OfflineProxyTransport: MeshTransport { func send(_ request: MeshHTTPRequest) async throws -> MeshHTTPResponse { throw MeshClientError.transportUnavailable } }
private struct BrokenResolver: V1AgentResolver {
    func material(for profile: ProfileName) throws -> V1AgentMaterial { throw V1CustodyError.keyFileUnsafe }
}

public final class BufferProxyOutput: MCPProxyOutput, @unchecked Sendable {
    private let lock = NSLock(); private var out = Data(); private var err = Data()
    public init() {}
    public var stdout: Data { lock.withLock { out } }; public var stderr: Data { lock.withLock { err } }
    public func writeStdout(_ data: Data) { lock.withLock { out.append(data) } }
    public func writeStderr(_ data: Data) { lock.withLock { err.append(data) } }
    var stdoutJSONRPCErrorCode: Int? { guard let object = try? JSONSerialization.jsonObject(with: stdout) as? [String: Any], let error = object["error"] as? [String: Any] else { return nil }; return error["code"] as? Int }
    var stdoutJSONRPCID: Int? { guard let object = try? JSONSerialization.jsonObject(with: stdout) as? [String: Any] else { return nil }; return object["id"] as? Int }
}

private final class MCPFixtureURLProtocol: URLProtocol, @unchecked Sendable {
    struct Fixture: Sendable { let status: Int; let url: URL; let headers: [String: String]; let body: Data }
    private static let lock = NSLock(); nonisolated(unsafe) private static var fixtures: [Fixture] = []; nonisolated(unsafe) private static var captured: [URLRequest] = []
    static var requests: [URLRequest] { lock.withLock { captured } }
    static func reset(_ values: [Fixture]) { lock.withLock { fixtures = values; captured = [] } }
    override class func canInit(with request: URLRequest) -> Bool { true }; override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() { let fixture: Fixture? = Self.lock.withLock { Self.captured.append(request); return Self.fixtures.isEmpty ? nil : Self.fixtures.removeFirst() }; guard let fixture else { client?.urlProtocol(self, didFailWithError: URLError(.resourceUnavailable)); return }; let response = HTTPURLResponse(url: fixture.url, statusCode: fixture.status, httpVersion: "HTTP/1.1", headerFields: fixture.headers)!; client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed); client?.urlProtocol(self, didLoad: fixture.body); client?.urlProtocolDidFinishLoading(self) }
    override func stopLoading() {}
}

