// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "NoltriAXP0Spike",
    platforms: [.macOS(.v13)],
    products: [
        .library(name: "NoltriAXP0Spike", type: .static, targets: ["NoltriAXP0Spike"]),
        .executable(name: "noltri-ax-p0-probe", targets: ["NoltriAXProbe"]),
        .executable(name: "noltri-ax-p0-fixture", targets: ["NoltriAXFixture"]),
    ],
    targets: [
        .target(name: "NoltriAXP0Spike"),
        .executableTarget(name: "NoltriAXProbe", dependencies: ["NoltriAXP0Spike"]),
        .executableTarget(name: "NoltriAXFixture", dependencies: ["NoltriAXP0Spike"]),
        .testTarget(name: "NoltriAXP0SpikeTests", dependencies: ["NoltriAXP0Spike"]),
    ]
)
