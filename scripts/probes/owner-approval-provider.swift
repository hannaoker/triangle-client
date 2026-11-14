// Owner approval CLI provider (`triangle-owner-approval`). Validation mode never creates
// LAContext. Interactive OS prompts still require packaged interactive acceptance before live install.
import CoreFoundation
import CryptoKit
import Darwin
import Foundation
import LocalAuthentication

private struct Request: Decodable, Sendable {
    let version: Int
    let canonicalRequest: String
    let digest: String
    let nonce: String
    let summary: String
    let timeoutMs: Int
}

private func emit(_ request: Request, _ outcome: String) {
    let data = try! JSONSerialization.data(withJSONObject: [
        "version": 1, "digest": request.digest, "nonce": request.nonce, "outcome": outcome,
    ], options: [.sortedKeys])
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([10]))
}

private func matches(_ value: String, _ expression: String) -> Bool {
    guard let range = value.range(of: expression, options: .regularExpression) else { return false }
    return range == value.startIndex..<value.endIndex
}

private func exactInt(_ value: Any?) -> Int? {
    guard let num = value as? NSNumber,
          CFGetTypeID(num) != CFBooleanGetTypeID(),
          !CFNumberIsFloatType(num as CFNumber)
    else { return nil }
    return Int(exactly: num)
}

private func hasControlOrBackslash(_ value: String) -> Bool {
    value.unicodeScalars.contains { scalar in
        scalar == "\\" || scalar.properties.generalCategory == .control || scalar.properties.generalCategory == .format
    }
}

private func isValidNormalizedPosixPath(_ value: String, maxBytes: Int) -> Bool {
    guard !value.isEmpty, value.utf8.count <= maxBytes, value.hasPrefix("/"),
          !hasControlOrBackslash(value)
    else { return false }
    if value == "/" { return true }
    guard !value.hasSuffix("/") else { return false }
    let parts = value.dropFirst().split(separator: "/", omittingEmptySubsequences: false)
    return !parts.contains { $0.isEmpty || $0 == "." || $0 == ".." }
}

private func isValidBareHttpsOrigin(_ value: String) -> Bool {
    guard value.hasPrefix("https://"), !hasControlOrBackslash(value),
          !value.contains("@"), !value.contains("?"), !value.contains("#")
    else { return false }
    let afterScheme = value.dropFirst("https://".count)
    guard !afterScheme.isEmpty, !afterScheme.contains("/"),
          let components = URLComponents(string: value),
          components.scheme == "https",
          let host = components.host, !host.isEmpty,
          components.user == nil, components.password == nil,
          components.path.isEmpty, components.query == nil, components.fragment == nil
    else { return false }
    return true
}

private func validateSummary(for operation: [String: Any]) throws -> String {
    let baseKeys: Set<String> = ["schema", "nonce", "issuedAt", "deadline", "action"]
    guard let action = operation["action"] as? String else { throw CocoaError(.fileReadCorruptFile) }
    switch action {
    case "profile.revoke", "profile.move":
        let extraKeys: Set<String> = action == "profile.move"
            ? ["registryRoot", "expectedSequence", "profileId", "before", "after"]
            : ["registryRoot", "expectedSequence", "profileId", "before"]
        guard Set(operation.keys) == baseKeys.union(extraKeys),
              let profile = operation["profileId"] as? String, matches(profile, "^[a-f0-9]{64}$"),
              let root = operation["registryRoot"] as? String, isValidNormalizedPosixPath(root, maxBytes: 4096),
              let sequence = exactInt(operation["expectedSequence"]), sequence >= 1,
              let before = operation["before"] as? [String: Any],
              Set(before.keys) == Set(["bindingId", "bindingGeneration", "principalId", "authorityOrigin", "revokedAt"]),
              let bindingId = before["bindingId"] as? String, matches(bindingId, "^bind_[a-f0-9]{32}$"),
              let bindingGeneration = exactInt(before["bindingGeneration"]), bindingGeneration >= 1,
              let principal = before["principalId"] as? String, matches(principal, "^agent_[a-f0-9]{32}$"),
              let origin = before["authorityOrigin"] as? String, isValidBareHttpsOrigin(origin),
              before["revokedAt"] is NSNull
        else { throw CocoaError(.fileReadCorruptFile) }
        var expected = "\(action): \(profile)\nRegistry: \(root)\nSequence: \(sequence)\nFrom: \(principal) at \(origin)\n"
        if action == "profile.move" {
            guard let after = operation["after"] as? [String: Any],
                  Set(after.keys) == Set(["principalId", "authorityOrigin"]),
                  let target = after["principalId"] as? String, matches(target, "^agent_[a-f0-9]{32}$"),
                  let targetOrigin = after["authorityOrigin"] as? String, isValidBareHttpsOrigin(targetOrigin),
                  !(target == principal && targetOrigin == origin)
            else { throw CocoaError(.fileReadCorruptFile) }
            expected += "To: \(target) at \(targetOrigin)"
        } else {
            expected += "Revoke this binding"
        }
        return expected

    case "destination.set":
        let extraKeys: Set<String> = ["registryRoot", "expectedSequence", "principalId", "harness", "workspace", "before"]
        guard Set(operation.keys) == baseKeys.union(extraKeys),
              let root = operation["registryRoot"] as? String, isValidNormalizedPosixPath(root, maxBytes: 4096),
              let sequence = exactInt(operation["expectedSequence"]), sequence >= 1,
              let principal = operation["principalId"] as? String, matches(principal, "^agent_[a-f0-9]{32}$"),
              let harness = operation["harness"] as? String, ["claude", "codex"].contains(harness),
              let workspace = operation["workspace"] as? String, isValidNormalizedPosixPath(workspace, maxBytes: 1024),
              operation["before"] is NSNull
        else { throw CocoaError(.fileReadCorruptFile) }
        return "destination.set: \(principal)\nRegistry: \(root)\nSequence: \(sequence)\nTarget: \(harness) chat in \(workspace)"

    case "destination.clear":
        let extraKeys: Set<String> = ["registryRoot", "expectedSequence", "principalId", "before"]
        guard Set(operation.keys) == baseKeys.union(extraKeys),
              let root = operation["registryRoot"] as? String, isValidNormalizedPosixPath(root, maxBytes: 4096),
              let sequence = exactInt(operation["expectedSequence"]), sequence >= 1,
              let principal = operation["principalId"] as? String, matches(principal, "^agent_[a-f0-9]{32}$"),
              let before = operation["before"] as? [String: Any],
              Set(before.keys) == Set(["harness", "workspace", "generation"]),
              let harness = before["harness"] as? String, ["claude", "codex"].contains(harness),
              let workspace = before["workspace"] as? String, isValidNormalizedPosixPath(workspace, maxBytes: 1024),
              let generation = exactInt(before["generation"]), generation >= 1
        else { throw CocoaError(.fileReadCorruptFile) }
        return "destination.clear: \(principal)\nRegistry: \(root)\nSequence: \(sequence)\nClear: \(harness) chat in \(workspace) (gen \(generation))"

    case "chat.map.set":
        let extraKeys: Set<String> = [
            "storeRoot", "expectedSequence", "selectorId", "harness", "workspace",
            "principalId", "authorityOrigin", "bindingGeneration", "before",
        ]
        guard Set(operation.keys) == baseKeys.union(extraKeys),
              let root = operation["storeRoot"] as? String, isValidNormalizedPosixPath(root, maxBytes: 4096),
              let sequence = exactInt(operation["expectedSequence"]), sequence >= 0,
              let selectorId = operation["selectorId"] as? String, matches(selectorId, "^sel_[a-f0-9]{32}$"),
              let harness = operation["harness"] as? String, ["claude", "codex"].contains(harness),
              let workspace = operation["workspace"] as? String, isValidNormalizedPosixPath(workspace, maxBytes: 1024),
              let principal = operation["principalId"] as? String, matches(principal, "^agent_[a-f0-9]{32}$"),
              let origin = operation["authorityOrigin"] as? String, isValidBareHttpsOrigin(origin),
              let bindingGeneration = exactInt(operation["bindingGeneration"]), bindingGeneration >= 1,
              operation["before"] is NSNull
        else { throw CocoaError(.fileReadCorruptFile) }
        return "chat.map.set: \(selectorId)\nStore: \(root)\nSequence: \(sequence)\nSelector: \(harness) chat in \(workspace)\nPrincipal: \(principal) at \(origin) (gen \(bindingGeneration))"

    case "chat.map.confirm":
        let confirmKeys: Set<String> = ["storeRoot", "expectedSequence", "selectorId", "sessionAddress", "before"]
        guard Set(operation.keys) == baseKeys.union(confirmKeys),
              let confirmRoot = operation["storeRoot"] as? String, isValidNormalizedPosixPath(confirmRoot, maxBytes: 4096),
              let confirmSequence = exactInt(operation["expectedSequence"]), confirmSequence >= 1,
              let confirmSelector = operation["selectorId"] as? String, matches(confirmSelector, "^sel_[a-f0-9]{32}$"),
              let sessionAddress = operation["sessionAddress"] as? String, matches(sessionAddress, "^session-[a-f0-9]{64}$"),
              let confirmBefore = operation["before"] as? [String: Any],
              Set(confirmBefore.keys) == Set(["harness", "workspace", "principalId", "authorityOrigin", "bindingGeneration"]),
              let confirmHarness = confirmBefore["harness"] as? String, ["claude", "codex"].contains(confirmHarness),
              let confirmWorkspace = confirmBefore["workspace"] as? String, isValidNormalizedPosixPath(confirmWorkspace, maxBytes: 1024),
              let confirmPrincipal = confirmBefore["principalId"] as? String, matches(confirmPrincipal, "^agent_[a-f0-9]{32}$"),
              let confirmOrigin = confirmBefore["authorityOrigin"] as? String, isValidBareHttpsOrigin(confirmOrigin),
              let confirmGeneration = exactInt(confirmBefore["bindingGeneration"]), confirmGeneration >= 1
        else { throw CocoaError(.fileReadCorruptFile) }
        return "chat.map.confirm: \(confirmSelector)\nStore: \(confirmRoot)\nSequence: \(confirmSequence)\nSelector: \(confirmHarness) chat in \(confirmWorkspace)\nPrincipal: \(confirmPrincipal) at \(confirmOrigin) (gen \(confirmGeneration))\nSession: \(sessionAddress)\nConfirm this chat mapping"

    case "chat.map.revoke":
        let extraKeys: Set<String> = ["storeRoot", "expectedSequence", "selectorId", "before"]
        guard Set(operation.keys) == baseKeys.union(extraKeys),
              let root = operation["storeRoot"] as? String, isValidNormalizedPosixPath(root, maxBytes: 4096),
              let sequence = exactInt(operation["expectedSequence"]), sequence >= 1,
              let selectorId = operation["selectorId"] as? String, matches(selectorId, "^sel_[a-f0-9]{32}$"),
              let before = operation["before"] as? [String: Any],
              Set(before.keys) == Set(["harness", "workspace", "principalId", "authorityOrigin", "bindingGeneration"]),
              let harness = before["harness"] as? String, ["claude", "codex"].contains(harness),
              let workspace = before["workspace"] as? String, isValidNormalizedPosixPath(workspace, maxBytes: 1024),
              let principal = before["principalId"] as? String, matches(principal, "^agent_[a-f0-9]{32}$"),
              let origin = before["authorityOrigin"] as? String, isValidBareHttpsOrigin(origin),
              let bindingGeneration = exactInt(before["bindingGeneration"]), bindingGeneration >= 1
        else { throw CocoaError(.fileReadCorruptFile) }
        return "chat.map.revoke: \(selectorId)\nStore: \(root)\nSequence: \(sequence)\nSelector: \(harness) chat in \(workspace)\nPrincipal: \(principal) at \(origin) (gen \(bindingGeneration))\nRevoke this chat mapping"

    default:
        throw CocoaError(.fileReadCorruptFile)
    }
}

private func readRequest() throws -> Request {
    var data = Data()
    while let chunk = try FileHandle.standardInput.read(upToCount: 4096), !chunk.isEmpty {
        data.append(chunk)
        guard data.count <= 16384 else { throw CocoaError(.fileReadTooLarge) }
    }
    guard let frame = try JSONSerialization.jsonObject(with: data) as? [String: Any],
          Set(frame.keys) == Set(["version", "canonicalRequest", "digest", "nonce", "summary", "timeoutMs"]),
          let frameVersion = exactInt(frame["version"]), frameVersion == 1,
          let timeoutMs = exactInt(frame["timeoutMs"]), (1...120000).contains(timeoutMs)
    else { throw CocoaError(.fileReadCorruptFile) }
    let request = try JSONDecoder().decode(Request.self, from: data)
    let digest = SHA256.hash(data: Data(request.canonicalRequest.utf8)).map { String(format: "%02x", $0) }.joined()
    guard request.version == 1, (1...120000).contains(request.timeoutMs),
          matches(request.nonce, "^[a-f0-9]{64}$"), request.digest == digest,
          let operation = try JSONSerialization.jsonObject(with: Data(request.canonicalRequest.utf8)) as? [String: Any],
          operation["schema"] as? String == "owner_operation_v1",
          operation["nonce"] as? String == request.nonce,
          let issuedAt = exactInt(operation["issuedAt"]), issuedAt >= 0,
          let deadline = exactInt(operation["deadline"]),
          deadline > issuedAt, deadline - issuedAt <= 120000
    else { throw CocoaError(.fileReadCorruptFile) }
    let expected = try validateSummary(for: operation)
    guard expected == request.summary else { throw CocoaError(.fileReadCorruptFile) }
    return request
}

@main
private struct OwnerApprovalProvider {
    @MainActor static func main() async {
        let args = Array(CommandLine.arguments.dropFirst())
        guard args == ["--authenticate"] || args == ["--validate-request"] else { exit(64) }
        let request: Request
        do { request = try readRequest() } catch { exit(64) }
        if args == ["--validate-request"] { emit(request, "unavailable"); return }
        let context = LAContext()
        // This disables biometric reuse, not a claim of fresh OS authentication.
        // Fresh interaction and password fallback remain interactive release gates.
        context.touchIDAuthenticationAllowableReuseDuration = 0
        context.localizedCancelTitle = "Cancel identity change"
        var error: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else {
            emit(request, "unavailable"); context.invalidate(); return
        }
        signal(SIGTERM, SIG_IGN)
        let cancellation = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
        cancellation.setEventHandler {
            context.invalidate(); emit(request, "cancelled"); exit(0)
        }
        cancellation.resume()
        let timeout = DispatchSource.makeTimerSource(queue: .main)
        timeout.schedule(deadline: .now() + .milliseconds(request.timeoutMs))
        timeout.setEventHandler {
            context.invalidate(); emit(request, "unavailable"); exit(0)
        }
        timeout.resume()
        let outcome: String
        do {
            let approved = try await context.evaluatePolicy(.deviceOwnerAuthentication,
                localizedReason: request.summary + "\nOperation: " + String(request.digest.prefix(16)))
            outcome = approved ? "approved" : "denied"
        } catch let failure as LAError {
            switch failure.code {
            case .userCancel, .appCancel, .systemCancel: outcome = "cancelled"
            case .authenticationFailed: outcome = "denied"
            default: outcome = "unavailable"
            }
        } catch { outcome = "unavailable" }
        timeout.cancel(); cancellation.cancel(); context.invalidate(); emit(request, outcome)
    }
}
