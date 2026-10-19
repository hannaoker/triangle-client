// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "TriangleMailbox",
    platforms: [.macOS(.v13)],
    products: [
        .library(name: "TriangleMailboxCore", targets: ["TriangleMailboxCore"]),
        .executable(name: "triangle-mailbox", targets: ["TriangleMailbox"]),
        .executable(name: "triangle-client", targets: ["TriangleClient"]),
        .executable(name: "TriangleMailboxHostTests", targets: ["TriangleMailboxHostTests"]),
    ],
    targets: [
        .target(name: "TriangleMailboxCore"),
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
            dependencies: ["TriangleMailboxCore"],
            path: "Tests/TriangleMailboxTestSupport"
        ),
        .executableTarget(
            name: "TriangleMailboxHostTests",
            dependencies: ["TriangleMailboxTestSupport"],
            path: "Tests/TriangleMailboxHostTests"
        ),
        .testTarget(
            name: "TriangleMailboxCoreTests",
            dependencies: ["TriangleMailboxTestSupport"]
        ),
    ]
)
