import Foundation

public protocol MCPProxyOutput: AnyObject, Sendable {
    func writeStdout(_ data: Data)
    func writeStderr(_ data: Data)
}

public final class FileHandleMCPProxyOutput: MCPProxyOutput, @unchecked Sendable {
    private let stdout: FileHandle
    private let stderr: FileHandle

    public init(stdout: FileHandle = .standardOutput, stderr: FileHandle = .standardError) {
        self.stdout = stdout
        self.stderr = stderr
    }

    public func writeStdout(_ data: Data) {
        stdout.write(data)
        try? stdout.synchronize()
    }
    public func writeStderr(_ data: Data) {
        stderr.write(data)
        try? stderr.synchronize()
    }
}

public protocol MCPProxyInput: AnyObject, Sendable {
    func readLine(maximumBytes: Int) throws -> Data?
}

public enum MCPProxyInputError: Error, Equatable, Sendable { case messageTooLarge, inputFailure }

public final class FileHandleMCPProxyInput: MCPProxyInput, @unchecked Sendable {
    private let handle: FileHandle
    private var buffer = Data()
    private var reachedEOF = false

    public init(handle: FileHandle = .standardInput) { self.handle = handle }

    public func readLine(maximumBytes: Int) throws -> Data? {
        while true {
            if let newline = buffer.firstIndex(of: 0x0a) {
                let length = buffer.distance(from: buffer.startIndex, to: newline)
                guard length <= maximumBytes else { throw MCPProxyInputError.messageTooLarge }
                let line = Data(buffer[..<newline])
                buffer.removeSubrange(...newline)
                return stripCarriageReturn(line)
            }
            guard buffer.count <= maximumBytes else { throw MCPProxyInputError.messageTooLarge }
            if reachedEOF {
                guard !buffer.isEmpty else { return nil }
                let line = buffer
                buffer.removeAll(keepingCapacity: false)
                return stripCarriageReturn(line)
            }
            do {
                guard let chunk = try handle.read(upToCount: 4096), !chunk.isEmpty else {
                    reachedEOF = true
                    continue
                }
                buffer.append(chunk)
            } catch {
                throw MCPProxyInputError.inputFailure
            }
        }
    }

    private func stripCarriageReturn(_ data: Data) -> Data {
        guard data.last == 0x0d else { return data }
        return data.dropLast()
    }
}

private final class DataMCPProxyInput: MCPProxyInput, @unchecked Sendable {
    private let lock = NSLock()
    private var data: Data
    init(_ data: Data) { self.data = data }

    func readLine(maximumBytes: Int) throws -> Data? {
        try lock.withLock {
            guard !data.isEmpty else { return nil }
            if let newline = data.firstIndex(of: 0x0a) {
                let length = data.distance(from: data.startIndex, to: newline)
                guard length <= maximumBytes else { throw MCPProxyInputError.messageTooLarge }
                var line = Data(data[..<newline])
                data.removeSubrange(...newline)
                if line.last == 0x0d { line.removeLast() }
                return line
            }
            guard data.count <= maximumBytes else { throw MCPProxyInputError.messageTooLarge }
            let line = data
            data.removeAll()
            return line
        }
    }
}

public enum MCPProxyRunResult: Equatable, Sendable {
    case completed
    case failed
    case terminatedForSecretInvariant
}

private struct MCPProxySession {
    let credential: VerifiedCredential
    let workloadAuth: WorkloadTokenManager?

    func authorizationHeaders(method: String, url: URL) async throws -> [String: String] {
        if let workloadAuth {
            return try await workloadAuth.authorizationHeaders(method: method, url: url)
        }
        return ["Authorization": credential.authorizationValue]
    }

    var protectedValues: [String] {
        var values = [credential.binding.token.secretValue, credential.authorizationValue]
        if let accessToken = workloadAuth?.activeAccessToken {
            values.append(accessToken)
            values.append("Bearer \(accessToken)")
        }
        return values
    }
}

public struct MCPProxy: Sendable {
    public static let maximumMessageBytes = 16 * 1024
    public static let maximumResponseBytes = 64 * 1024

    private let gate: VerifiedCredentialGate
    private let workloadKeyStore: any WorkloadKeyStore
    private let transport: any MeshTransport

    public init(
        gate: VerifiedCredentialGate,
        transport: any MeshTransport,
        workloadKeyStore: (any WorkloadKeyStore)? = nil
    ) {
        self.gate = gate
        self.transport = transport
        #if canImport(Security)
        self.workloadKeyStore = workloadKeyStore ?? KeychainWorkloadKeyStore()
        #else
        self.workloadKeyStore = workloadKeyStore ?? InMemoryWorkloadKeyStore()
        #endif
    }

    public func run(profile: ProfileName, input: Data, output: any MCPProxyOutput) async -> MCPProxyRunResult {
        await run(profile: profile, input: DataMCPProxyInput(input), output: output)
    }

    public func run(profile: ProfileName, input: any MCPProxyInput, output: any MCPProxyOutput) async -> MCPProxyRunResult {
        var session: MCPProxySession?
        while true {
            let line: Data
            do {
                guard let next = try input.readLine(maximumBytes: Self.maximumMessageBytes) else { return .completed }
                if next.isEmpty { continue }
                line = next
            } catch MCPProxyInputError.messageTooLarge {
                write(errorResponse(id: nil, code: -32600, message: "invalid request"), toStdout: true, output: output)
                return .failed
            } catch {
                writeDiagnostic("input_failed", output: output)
                return .failed
            }

            let request: JSONRPCRequest
            do {
                request = try JSONRPCRequest.decode(line)
            } catch JSONRPCValidationError.parse {
                write(errorResponse(id: nil, code: -32700, message: "parse error"), toStdout: true, output: output)
                continue
            } catch {
                write(errorResponse(id: nil, code: -32600, message: "invalid request"), toStdout: true, output: output)
                continue
            }

            if request.isForbiddenLocalOperation {
                if !request.isNotification {
                    write(errorResponse(id: request.safeResponseID, code: -32601, message: "method not found"), toStdout: true, output: output)
                }
                continue
            }

            if session == nil {
                let credential: VerifiedCredential
                do { credential = try await gate.credential(for: profile) }
                catch {
                    writeDiagnostic(gateReason(error), output: output)
                    return .failed
                }
                let workloadAuth: WorkloadTokenManager?
                if let workloadRecord = try? workloadKeyStore.read(for: profile) {
                    workloadAuth = try? WorkloadTokenManager(
                        origin: credential.origin,
                        workloadRecord: workloadRecord,
                        transport: transport
                    )
                } else {
                    workloadAuth = nil
                }
                session = MCPProxySession(credential: credential, workloadAuth: workloadAuth)
            }
            guard let session else { return .failed }

            // The MCP channel is an operation channel, never a credential
            // import path. Reject even an exact caller-supplied copy before it
            // can be forwarded or reflected by an upstream diagnostic.
            if dataContainsSecret(line, session: session) {
                if !request.isNotification { writeInvariantFailure(output: output) }
                return .terminatedForSecretInvariant
            }

            let endpoint = URL(string: session.credential.origin.value + "/api/mcp")!
            let response: MeshHTTPResponse
            do {
                var headers = [
                    "Accept": "application/json",
                    "Content-Type": "application/json",
                ]
                headers.merge(try await session.authorizationHeaders(method: "POST", url: endpoint)) { _, new in new }
                response = try await transport.send(MeshHTTPRequest(
                    method: "POST",
                    url: endpoint,
                    headers: headers,
                    body: line
                ))
            } catch {
                if request.isNotification { continue }
                let diagnostic = errorResponse(id: request.id, code: -32603, message: "upstream unavailable")
                guard writeAuthenticated(diagnostic, session: session, output: output) else {
                    return .terminatedForSecretInvariant
                }
                continue
            }

            if containsSecret(response, session: session) {
                if !request.isNotification { writeInvariantFailure(output: output) }
                return .terminatedForSecretInvariant
            }
            if request.isNotification {
                // JSON-RPC notifications never produce JSON-RPC output. MESH
                // acknowledges them only with an exact empty HTTP 202.
                guard validNotificationAcknowledgement(response, endpoint: endpoint) else { continue }
                continue
            }
            guard validRemoteEnvelope(response, endpoint: endpoint, requestID: request.id) else {
                let diagnostic = errorResponse(id: request.id, code: -32603, message: "invalid upstream response")
                guard writeAuthenticated(diagnostic, session: session, output: output) else {
                    return .terminatedForSecretInvariant
                }
                continue
            }
            var forwarded = response.body
            forwarded.append(0x0a)
            if dataContainsSecret(forwarded, session: session) {
                write(Data("{\"error\":\"credential_invariant_failed\"}\n".utf8), toStdout: false, output: output)
                return .terminatedForSecretInvariant
            }
            output.writeStdout(forwarded)
        }
    }

    private func validNotificationAcknowledgement(_ response: MeshHTTPResponse, endpoint: URL) -> Bool {
        response.statusCode == 202 && response.body.isEmpty &&
            response.finalURL.absoluteString == endpoint.absoluteString &&
            response.finalURL.scheme?.lowercased() == "https"
    }

    private func validRemoteEnvelope(_ response: MeshHTTPResponse, endpoint: URL, requestID: Any?) -> Bool {
        guard response.statusCode == 200,
              response.body.count <= Self.maximumResponseBytes,
              response.finalURL.absoluteString == endpoint.absoluteString,
              response.finalURL.scheme?.lowercased() == "https"
        else { return false }
        guard let analysis = try? StrictJSONScanner.analyze(response.body), !analysis.hasDuplicateKeys else { return false }
        let contentType = response.headers.first { $0.key.caseInsensitiveCompare("Content-Type") == .orderedSame }?.value
        guard contentType?.split(separator: ";", maxSplits: 1).first?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "application/json",
              let object = try? JSONSerialization.jsonObject(with: response.body),
              let dictionary = object as? [String: Any],
              Set(dictionary.keys).isSubset(of: ["jsonrpc", "id", "result", "error"]),
              dictionary["jsonrpc"] as? String == "2.0",
              JSONRPCRequest.validID(dictionary["id"]),
              (dictionary["result"] != nil) != (dictionary["error"] != nil),
              validRemoteError(dictionary["error"])
        else { return false }
        return JSONRPCRequest.idsEqual(dictionary["id"], requestID)
    }

    private func validRemoteError(_ value: Any?) -> Bool {
        guard let value else { return true }
        guard let error = value as? [String: Any],
              Set(error.keys).isSubset(of: ["code", "message", "data"]),
              let code = error["code"] as? NSNumber,
              CFGetTypeID(code) != CFBooleanGetTypeID(),
              code.doubleValue.rounded(.towardZero) == code.doubleValue,
              error["message"] is String
        else { return false }
        return true
    }

    private func containsSecret(_ response: MeshHTTPResponse, session: MCPProxySession) -> Bool {
        if dataContainsSecret(response.body, session: session) { return true }
        for protected in session.protectedValues {
            if response.finalURL.absoluteString.contains(protected) { return true }
            if response.headers.contains(where: { $0.key.contains(protected) || $0.value.contains(protected) }) {
                return true
            }
        }
        return false
    }

    private func dataContainsSecret(_ data: Data, session: MCPProxySession) -> Bool {
        for protected in session.protectedValues {
            if data.range(of: Data(protected.utf8)) != nil { return true }
        }
        guard let analysis = try? StrictJSONScanner.analyze(data) else { return false }
        for protected in session.protectedValues {
            if analysis.sourceStrings.contains(where: { $0.contains(protected) }) { return true }
            let valueConcatenation = analysis.stringValues.joined()
            let sourceConcatenation = analysis.sourceStrings.joined()
            if valueConcatenation.contains(protected) || sourceConcatenation.contains(protected) {
                return true
            }
        }
        return false
    }

    private func gateReason(_ error: Error) -> String {
        switch error as? VerifiedCredentialGateError {
        case .profileNotFound: "profile_not_found"
        case .localAuthorizationRequired: "local_authorization_required"
        case .offline: "identity_verification_offline"
        case .identityMismatch: "identity_mismatch"
        case .journalIneligible: "profile_ineligible"
        case .profileStateInconsistent: "profile_state_inconsistent"
        case .verificationFailed, .none: "identity_verification_failed"
        }
    }

    private func writeDiagnostic(_ reason: String, output: any MCPProxyOutput) {
        write(Data("{\"error\":\"\(reason)\"}\n".utf8), toStdout: false, output: output)
    }

    private func writeAuthenticated(_ data: Data, session: MCPProxySession, output: any MCPProxyOutput) -> Bool {
        guard !dataContainsSecret(data, session: session) else {
            writeInvariantFailure(output: output)
            return false
        }
        output.writeStdout(data)
        return true
    }

    private func write(_ data: Data, toStdout: Bool, output: any MCPProxyOutput) {
        if toStdout { output.writeStdout(data) } else { output.writeStderr(data) }
    }

    private func writeInvariantFailure(output: any MCPProxyOutput) {
        output.writeStderr(Data("{\"error\":\"credential_invariant_failed\"}\n".utf8))
    }

    private func errorResponse(id: Any?, code: Int, message: String) -> Data {
        let object: [String: Any] = [
            "jsonrpc": "2.0",
            "id": id ?? NSNull(),
            "error": ["code": code, "message": message],
        ]
        var data = (try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])) ?? Data("{\"error\":\"internal_error\"}".utf8)
        data.append(0x0a)
        return data
    }
}

private enum JSONRPCValidationError: Error { case parse, shape }

private struct JSONRPCRequest {
    let id: Any?
    let hasID: Bool
    let method: String
    let params: Any?

    static func decode(_ data: Data) throws -> Self {
        let analysis: StrictJSONAnalysis
        do { analysis = try StrictJSONScanner.analyze(data) }
        catch { throw JSONRPCValidationError.parse }
        guard !analysis.hasDuplicateKeys else { throw JSONRPCValidationError.shape }
        let object: Any
        do { object = try JSONSerialization.jsonObject(with: data) }
        catch { throw JSONRPCValidationError.parse }
        guard let dictionary = object as? [String: Any],
              Set(dictionary.keys).isSubset(of: ["jsonrpc", "id", "method", "params"]),
              dictionary["jsonrpc"] as? String == "2.0",
              let method = dictionary["method"] as? String,
              !method.isEmpty,
              method.utf8.count <= 256,
              validID(dictionary["id"])
        else { throw JSONRPCValidationError.shape }
        if let params = dictionary["params"], !(params is [String: Any]) && !(params is [Any]) {
            throw JSONRPCValidationError.shape
        }
        return Self(id: dictionary["id"], hasID: dictionary.keys.contains("id"), method: method, params: dictionary["params"])
    }

    static func validID(_ value: Any?) -> Bool {
        guard let value else { return true }
        if value is NSNull { return true }
        if let string = value as? String {
            // IDs are reflected by JSON-RPC peers. A credential-shaped ID is
            // unnecessary for MCP and unsafe to echo.
            return string.wholeMatch(of: /^mesh_[a-f0-9]{64}$/) == nil
        }
        if let number = value as? NSNumber { return CFGetTypeID(number) != CFBooleanGetTypeID() }
        return false
    }

    static func idsEqual(_ lhs: Any?, _ rhs: Any?) -> Bool {
        switch (lhs, rhs) {
        case (nil, nil), (_ as NSNull, nil), (nil, _ as NSNull), (_ as NSNull, _ as NSNull): true
        case let (left as String, right as String): left == right
        case let (left as NSNumber, right as NSNumber): CFGetTypeID(left) != CFBooleanGetTypeID() && CFGetTypeID(right) != CFBooleanGetTypeID() && left == right
        default: false
        }
    }

    var isForbiddenLocalOperation: Bool {
        if forbidden(method) { return true }
        guard method == "tools/call", let dictionary = params as? [String: Any], let name = dictionary["name"] as? String else { return false }
        return forbidden(name)
    }

    var isNotification: Bool { !hasID }

    var safeResponseID: Any? {
        guard let string = id as? String else { return id }
        return string.firstMatch(of: /mesh_[a-f0-9]{64}/) == nil ? string : nil
    }

    private func forbidden(_ value: String) -> Bool {
        value == "mesh.mailbox.register" || value == "mesh.registration_challenge" ||
            value == "mesh.complete_registration" || value.hasPrefix("triangle.local.") ||
            value.contains(".credential.") || value.contains(".profile.")
    }
}

private struct StrictJSONAnalysis {
    let stringValues: [String]
    let sourceStrings: [String]
    let hasDuplicateKeys: Bool
}

private enum StrictJSONScanError: Error { case malformed }

private struct StrictJSONScanner {
    private let bytes: [UInt8]
    private var index = 0
    private var values: [String] = []
    private var sourceStrings: [String] = []
    private var duplicateKeys = false

    static func analyze(_ data: Data) throws -> StrictJSONAnalysis {
        var scanner = Self(bytes: Array(data))
        try scanner.skipWhitespace()
        try scanner.parseValue(recordString: true)
        try scanner.skipWhitespace()
        guard scanner.index == scanner.bytes.count else { throw StrictJSONScanError.malformed }
        return StrictJSONAnalysis(
            stringValues: scanner.values,
            sourceStrings: scanner.sourceStrings,
            hasDuplicateKeys: scanner.duplicateKeys
        )
    }

    private mutating func parseValue(recordString: Bool) throws {
        try skipWhitespace()
        guard let byte = current else { throw StrictJSONScanError.malformed }
        switch byte {
        case 0x7b: try parseObject()
        case 0x5b: try parseArray()
        case 0x22:
            let string = try parseString()
            if recordString {
                values.append(string)
                sourceStrings.append(string)
            }
        case 0x74: try consumeLiteral("true")
        case 0x66: try consumeLiteral("false")
        case 0x6e: try consumeLiteral("null")
        case 0x2d, 0x30...0x39: try consumeNumber()
        default: throw StrictJSONScanError.malformed
        }
    }

    private mutating func parseObject() throws {
        try consume(0x7b)
        try skipWhitespace()
        if current == 0x7d { index += 1; return }
        var keys = Set<String>()
        while true {
            guard current == 0x22 else { throw StrictJSONScanError.malformed }
            let key = try parseString()
            // Member names participate in the same source-order decoded
            // string stream as values. This closes escaped key-only and
            // key/value boundary reconstruction paths while preserving the
            // original JSON bytes and JSON-RPC ID representation.
            sourceStrings.append(key)
            if !keys.insert(key).inserted { duplicateKeys = true }
            try skipWhitespace(); try consume(0x3a)
            try parseValue(recordString: true)
            try skipWhitespace()
            if current == 0x7d { index += 1; return }
            try consume(0x2c); try skipWhitespace()
        }
    }

    private mutating func parseArray() throws {
        try consume(0x5b)
        try skipWhitespace()
        if current == 0x5d { index += 1; return }
        while true {
            try parseValue(recordString: true)
            try skipWhitespace()
            if current == 0x5d { index += 1; return }
            try consume(0x2c); try skipWhitespace()
        }
    }

    private mutating func parseString() throws -> String {
        let start = index
        try consume(0x22)
        while let byte = current {
            if byte == 0x22 {
                index += 1
                var wrapped = Data([0x5b])
                wrapped.append(contentsOf: bytes[start..<index])
                wrapped.append(0x5d)
                guard let decoded = try? JSONSerialization.jsonObject(with: wrapped) as? [String], decoded.count == 1 else {
                    throw StrictJSONScanError.malformed
                }
                return decoded[0]
            }
            guard byte >= 0x20 else { throw StrictJSONScanError.malformed }
            if byte == 0x5c {
                index += 1
                guard current != nil else { throw StrictJSONScanError.malformed }
            }
            index += 1
        }
        throw StrictJSONScanError.malformed
    }

    private mutating func consumeLiteral(_ literal: StaticString) throws {
        let expected = Array(String(describing: literal).utf8)
        guard index + expected.count <= bytes.count,
              Array(bytes[index..<(index + expected.count)]) == expected
        else { throw StrictJSONScanError.malformed }
        index += expected.count
    }

    private mutating func consumeNumber() throws {
        let start = index
        while let byte = current, !Self.isDelimiter(byte) { index += 1 }
        guard index > start else { throw StrictJSONScanError.malformed }
    }

    private mutating func consume(_ expected: UInt8) throws {
        guard current == expected else { throw StrictJSONScanError.malformed }
        index += 1
    }

    private mutating func skipWhitespace() throws {
        while let byte = current, [0x20, 0x09, 0x0a, 0x0d].contains(byte) { index += 1 }
    }

    private var current: UInt8? { index < bytes.count ? bytes[index] : nil }
    private static func isDelimiter(_ byte: UInt8) -> Bool {
        byte == 0x2c || byte == 0x5d || byte == 0x7d || byte == 0x20 || byte == 0x09 || byte == 0x0a || byte == 0x0d
    }
}
