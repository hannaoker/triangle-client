import Foundation
import TriangleMailboxTestSupport

@main
enum TriangleMailboxHostTests {
    static func main() async {
        do {
            for contractCase in ModelContractCases.all {
                try contractCase.run()
                print("PASS \(contractCase.name)")
            }
            for contractCase in CredentialStoreContractCases.all {
                try contractCase.run()
                print("PASS \(contractCase.name)")
            }
            for contractCase in ClientInstanceContractCases.all {
                try contractCase.run()
                print("PASS \(contractCase.name)")
            }
            for contractCase in EnrollmentContractCases.all {
                try await contractCase.run()
                print("PASS \(contractCase.name)")
            }
            for contractCase in MCPProxyContractCases.all {
                try await contractCase.run()
                print("PASS \(contractCase.name)")
            }
            for contractCase in WorkerLauncherContractCases.all {
                try await contractCase.run()
                print("PASS \(contractCase.name)")
            }
            for contractCase in ClientSupervisorContractCases.all {
                try await contractCase.run()
                print("PASS \(contractCase.name)")
            }
            for contractCase in TriangleClientCLIContractCases.all {
                try await contractCase.run()
                print("PASS \(contractCase.name)")
            }
            for contractCase in WatchGrantContractCases.all {
                try await contractCase.run()
                print("PASS \(contractCase.name)")
            }
            for contractCase in MailboxTransactionContractCases.all {
                try await contractCase.run()
                print("PASS \(contractCase.name)")
            }
            try StatusOutputContractCases.boundedStatus()
            print("PASS sanitized operator status")
            try await EndToEndContractCases.crossSessionMailboxLifecycle()
            print("PASS cross-session mailbox credential custody")
        } catch {
            FileHandle.standardError.write(Data("FAIL \(error)\n".utf8))
            exit(1)
        }
    }
}
