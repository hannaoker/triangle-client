#if canImport(Darwin)
import Darwin
import Security

enum KeychainLegacyAccess {
    static var allowsInteractiveUI: Bool {
        isatty(STDIN_FILENO) != 0
    }

    static func legacyQuery(from query: [CFString: Any]) -> [CFString: Any] {
        var fallback = query
        fallback.removeValue(forKey: kSecUseDataProtectionKeychain)
        if !allowsInteractiveUI {
            fallback[kSecUseAuthenticationUI] = kSecUseAuthenticationUIFail
        }
        return fallback
    }
}
#endif
