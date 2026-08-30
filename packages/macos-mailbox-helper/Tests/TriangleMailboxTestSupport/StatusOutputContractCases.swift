import Foundation
@_spi(EnrollmentTesting) import TriangleMailboxCore

public enum StatusOutputContractCases {
    public static func boundedStatus() throws {
        let status = ProfileStatus.durable(
            profile: try ProfileName("codex-mailbox-live"),
            binding: CredentialBinding(
                origin: try MeshOrigin("https://thetriangle.dev"),
                agentID: try AgentID("agent_" + String(repeating: "a", count: 32)),
                handle: try MailboxHandle("codex-mailbox-live"),
                token: try MeshToken("mesh_" + String(repeating: "c", count: 64))
            ),
            status: .verified
        )
        let rendered = try OperatorStatusRenderer.render(
            status,
            verificationTimestamp: Date(timeIntervalSince1970: 1_787_961_600)
        )
        guard let object = try JSONSerialization.jsonObject(with: rendered.stdout) as? [String: Any] else {
            throw StatusContractError.failed("status was not a JSON object")
        }
        let expected = Set(["profile", "origin", "agentId", "handle", "lifecycle", "verificationTimestamp", "operatorAction"])
        guard Set(object.keys) == expected else { throw StatusContractError.failed("status keys were not bounded") }
        guard object["lifecycle"] as? String == "verified" else { throw StatusContractError.failed("lifecycle mismatch") }
        guard object["verificationTimestamp"] as? String == "2026-08-29T00:00:00.000Z" else {
            throw StatusContractError.failed("verification timestamp mismatch")
        }
        guard !String(decoding: rendered.stdout, as: UTF8.self).contains("mesh_") else {
            throw StatusContractError.failed("status exposed token")
        }
    }
}

private enum StatusContractError: Error { case failed(String) }
