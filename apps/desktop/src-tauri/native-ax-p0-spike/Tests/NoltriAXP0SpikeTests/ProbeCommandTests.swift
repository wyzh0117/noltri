import XCTest
@testable import NoltriAXP0Spike

final class ProbeCommandTests: XCTestCase {
    func testOnlyTrustCheckAndOwnedFixtureExerciseAreAccepted() {
        XCTAssertEqual(AXProbeCommand.parse(["--check-trust"]), .checkTrust)
        XCTAssertEqual(AXProbeCommand.parse(["--exercise"]), .exerciseOwnedFixture)
    }

    func testCallerSuppliedPIDOrOtherTargetIsRejectedBeforeAXWorkCanStart() {
        XCTAssertNil(AXProbeCommand.parse(["--exercise", "4242"]))
        XCTAssertNil(AXProbeCommand.parse(["--exercise", "-1"]))
        XCTAssertNil(AXProbeCommand.parse(["--exercise", "/Applications/SomeApp.app"]))
        XCTAssertNil(AXProbeCommand.parse(["--target-pid", "4242"]))
    }
}
