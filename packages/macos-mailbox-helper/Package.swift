// swift-tools-version: 6.0

import PackageDescription

// Linux hosts do not ship Apple's CryptoKit. swift-crypto's Crypto module is
// API-compatible and is linked only when this package is built off macOS.
#if os(Linux)
let packageDependencies: [Package.Dependency] = [
    .package(url: "https://github.com/apple/swift-crypto.git", from: "3.12.0"),
]
let cryptoDependencies: [Target.Dependency] = [
    .product(name: "Crypto", package: "swift-crypto"),
]
#else
let packageDependencies: [Package.Dependency] = []
let cryptoDependencies: [Target.Dependency] = []
#endif

let package = Package(
    name: "TriangleMailbox",
    platforms: [.macOS(.v13)],
    products: [
        .library(name: "TriangleMailboxCore", targets: ["TriangleMailboxCore"]),
        .executable(name: "triangle-mailbox", targets: ["TriangleMailbox"]),
        .executable(name: "triangle-client", targets: ["TriangleClient"]),
        .executable(name: "TriangleMailboxHostTests", targets: ["TriangleMailboxHostTests"]),
        .executable(
            name: "TriangleMailboxDisposableKeychainTest",
            targets: ["TriangleMailboxDisposableKeychainTest"]
        ),
    ],
    dependencies: packageDependencies,
    targets: [
        .target(name: "TriangleMailboxCore", dependencies: cryptoDependencies),
        .executableTarget(
            name: "TriangleMailbox",
            dependencies: ["TriangleMailboxCore"]
        ),
        .executableTarget(
            name: "TriangleClient",
            dependencies: ["TriangleMailboxCore"]
        ),
        .target(
            name: "TriangleMailboxTestSupport",
            dependencies: ["TriangleMailboxCore"] + cryptoDependencies,
            path: "Tests/TriangleMailboxTestSupport"
        ),
        .executableTarget(
            name: "TriangleMailboxHostTests",
            dependencies: ["TriangleMailboxTestSupport"],
            path: "Tests/TriangleMailboxHostTests"
        ),
        .executableTarget(
            name: "TriangleMailboxDisposableKeychainTest",
            dependencies: ["TriangleMailboxCore"],
            path: "Tests/TriangleMailboxDisposableKeychainTest"
        ),
        .testTarget(
            name: "TriangleMailboxCoreTests",
            dependencies: ["TriangleMailboxTestSupport"]
        ),
    ]
)
