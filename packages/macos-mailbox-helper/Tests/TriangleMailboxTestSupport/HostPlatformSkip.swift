import Foundation

/// Raised by host contract cases that exercise macOS-only lock semantics.
/// The host runner prints SKIP and continues. Assertions on macOS stay in place.
public struct HostPlatformSkip: Error, CustomStringConvertible, Sendable {
    public let reason: String
    public init(_ reason: String) { self.reason = reason }
    public var description: String { reason }
}
