// Candidate CLI provider, not installed or selected by Triangle. Validation mode
// never creates LAContext. OS interaction still needs separate live acceptance.
import Foundation
import LocalAuthentication
import CryptoKit
import Darwin

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
        "version": 1, "digest": request.digest, "nonce": request.nonce, "outcome": outcome
    ], options: [.sortedKeys])
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([10]))
}
private func matches(_ value: String, _ expression: String) -> Bool {
    value.range(of: expression, options: .regularExpression) != nil
}
private func readRequest() throws -> Request {
    var data = Data()
    while let chunk = try FileHandle.standardInput.read(upToCount: 4096), !chunk.isEmpty {
        data.append(chunk)
        guard data.count <= 16384 else { throw CocoaError(.fileReadTooLarge) }
    }
    guard let frame = try JSONSerialization.jsonObject(with: data) as? [String: Any],
          Set(frame.keys) == Set(["version", "canonicalRequest", "digest", "nonce", "summary", "timeoutMs"])
    else { throw CocoaError(.fileReadCorruptFile) }
    let request = try JSONDecoder().decode(Request.self, from: data)
    let digest = SHA256.hash(data: Data(request.canonicalRequest.utf8)).map { String(format: "%02x", $0) }.joined()
    guard request.version == 1, (1...120000).contains(request.timeoutMs),
          matches(request.nonce, "^[a-f0-9]{64}$"), request.digest == digest,
          let operation = try JSONSerialization.jsonObject(with: Data(request.canonicalRequest.utf8)) as? [String: Any],
          operation["schema"] as? String == "owner_operation_v1", operation["nonce"] as? String == request.nonce,
          let action = operation["action"] as? String, ["profile.move", "profile.revoke"].contains(action),
          let profile = operation["profileId"] as? String, matches(profile, "^[a-f0-9]{64}$"),
          let root = operation["registryRoot"] as? String, let sequence = operation["expectedSequence"] as? Int,
          let before = operation["before"] as? [String: Any],
          let principal = before["principalId"] as? String, let origin = before["authorityOrigin"] as? String
    else { throw CocoaError(.fileReadCorruptFile) }
    var expected = "\(action): \(profile)\nRegistry: \(root)\nSequence: \(sequence)\nFrom: \(principal) at \(origin)\n"
    if action == "profile.move" {
        guard let after = operation["after"] as? [String: Any], let target = after["principalId"] as? String,
              let targetOrigin = after["authorityOrigin"] as? String else { throw CocoaError(.fileReadCorruptFile) }
        expected += "To: \(target) at \(targetOrigin)"
    } else { expected += "Revoke this binding" }
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
