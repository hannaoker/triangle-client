import Foundation
import TriangleMailboxTestSupport

@main
enum TriangleMailboxHostTests {
    static func main() async {
        do {
            if ProcessInfo.processInfo.environment["TRIANGLE_CONTRACT_FILTER"] == "claimed-inbound-resume" {
                try await MailboxTransactionContractCases.claimedInboundSurvivesResume()
                print("PASS claimed inbound survives resume and is read exactly")
                return
            }
            if ProcessInfo.processInfo.environment["TRIANGLE_CONTRACT_FILTER"] == "mailbox-transactions" {
                for contractCase in MailboxTransactionContractCases.all {
                    try await contractCase.run()
                    print("PASS \(contractCase.name)")
                }
                return
            }
            var tally = HostTestTally()
            for contractCase in ModelContractCases.all {
                await run(contractCase.name, tally: &tally) { try contractCase.run() }
            }
            for contractCase in CredentialStoreContractCases.all {
                await run(contractCase.name, tally: &tally) { try contractCase.run() }
            }
            for contractCase in ClientInstanceContractCases.all {
                await run(contractCase.name, tally: &tally) { try contractCase.run() }
            }
            for contractCase in EnrollmentContractCases.all {
                await run(contractCase.name, tally: &tally) { try await contractCase.run() }
            }
            for contractCase in MCPProxyContractCases.all {
                await run(contractCase.name, tally: &tally) { try await contractCase.run() }
            }
            for contractCase in WorkerLauncherContractCases.all {
                await run(contractCase.name, tally: &tally) { try await contractCase.run() }
            }
            for contractCase in ClientSupervisorContractCases.all {
                await run(contractCase.name, tally: &tally) { try await contractCase.run() }
            }
            for contractCase in TriangleClientCLIContractCases.all {
                await run(contractCase.name, tally: &tally) { try await contractCase.run() }
            }
            for contractCase in WatchGrantContractCases.all {
                await run(contractCase.name, tally: &tally) { try await contractCase.run() }
            }
            for contractCase in MailboxTransactionContractCases.all {
                await run(contractCase.name, tally: &tally) { try await contractCase.run() }
            }
            for contractCase in CodexConversationStoreContractCases.all {
                await run(contractCase.name, tally: &tally) { try await contractCase.run() }
            }
            await run("sanitized operator status", tally: &tally) { try StatusOutputContractCases.boundedStatus() }
            await run("cross-session mailbox credential custody", tally: &tally) {
                try await EndToEndContractCases.crossSessionMailboxLifecycle()
            }
            print("HOST_TEST_SUMMARY pass=\(tally.pass) skip=\(tally.skip) fail=\(tally.fail)")
            if tally.fail != 0 { exit(1) }
        } catch {
            FileHandle.standardError.write(Data("FAIL \(error)\n".utf8))
            exit(1)
        }
    }

    private static func run(_ name: String, tally: inout HostTestTally, _ body: @Sendable () async throws -> Void) async {
        do {
            try await body()
            print("PASS \(name)")
            tally.pass += 1
        } catch let skip as HostPlatformSkip {
            print("SKIP \(name) (\(skip.reason))")
            tally.skip += 1
        } catch {
            FileHandle.standardError.write(Data("FAIL \(name): \(error)\n".utf8))
            tally.fail += 1
        }
    }
}

private struct HostTestTally {
    var pass = 0
    var skip = 0
    var fail = 0
}
