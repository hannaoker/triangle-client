#if canImport(Darwin)
import Darwin
import Security

enum KeychainLegacyAccess {
    /// Interactive Keychain prompts are opt-in only. LaunchAgents have no UI and
    /// must fail closed; set TRIANGLE_KEYCHAIN_UI=1 on a TTY to authorize once
    /// after an ad-hoc helper re-sign.
    static var allowsInteractiveUI: Bool {
        guard let enabled = getenv("TRIANGLE_KEYCHAIN_UI"), String(cString: enabled) == "1" else {
            return false
        }
        return isatty(STDIN_FILENO) != 0
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
