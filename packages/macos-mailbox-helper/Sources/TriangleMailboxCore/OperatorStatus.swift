import Foundation

/// The deliberately small, secret-free surface emitted by `triangle-mailbox status`.
public struct OperatorStatus: Codable, Equatable, Sendable {
    public let profile: String
    public let origin: String?
    public let agentID: String?
    public let handle: String?
    public let lifecycle: ProfileVerificationStatus
    public let verificationTimestamp: String?
    public let operatorAction: ProfileOperatorAction

    private enum CodingKeys: String, CodingKey {
        case profile, origin, handle, lifecycle, verificationTimestamp, operatorAction
        case agentID = "agentId"
    }
}

public enum OperatorStatusRenderer {
    public static func render(
        _ status: ProfileStatus,
        verificationTimestamp: Date? = nil
    ) throws -> RenderedCLIOutput {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        let output = OperatorStatus(
            profile: status.profile,
            origin: status.origin,
            agentID: status.agentID,
            handle: status.handle,
            lifecycle: status.status,
            verificationTimestamp: verificationTimestamp.map(formatter.string(from:)),
            operatorAction: status.operatorAction
        )
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        var stdout = try encoder.encode(output)
        stdout.append(0x0a)
        let exitCode: Int32 = switch status.status {
        case .verified, .offlineUnverified: 0
        default: 1
        }
        return RenderedCLIOutput(stdout: stdout, stderr: Data(), exitCode: exitCode)
    }
}
