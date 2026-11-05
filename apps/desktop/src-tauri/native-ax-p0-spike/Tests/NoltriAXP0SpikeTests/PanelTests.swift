import AppKit
import CoreGraphics
import XCTest
@testable import NoltriAXP0Spike

final class PanelTests: XCTestCase {
    func testAXBoundsPlacePanelBesideSelectionInAppKitScreenCoordinates() throws {
        let display = AXDisplayGeometry(
            axFrame: CGRect(x: 0, y: 0, width: 1440, height: 900),
            appKitFrame: CGRect(x: 0, y: 0, width: 1440, height: 900)
        )
        let selection = CGRect(x: 200, y: 120, width: 150, height: 18)
        let frame = try XCTUnwrap(AXPanelPlacement.frame(
            forAXBounds: selection,
            displays: [display],
            panelSize: CGSize(width: 320, height: 200),
            gap: 10
        ))

        XCTAssertEqual(frame, CGRect(x: 360, y: 580, width: 320, height: 200))
    }

    func testChoosesDisplayIntersectingSelectionInsteadOfFirstDisplay() throws {
        let primary = AXDisplayGeometry(
            axFrame: CGRect(x: 0, y: 0, width: 1440, height: 900),
            appKitFrame: CGRect(x: 0, y: 0, width: 1440, height: 900)
        )
        let leftDisplay = AXDisplayGeometry(
            axFrame: CGRect(x: -1000, y: 0, width: 1000, height: 800),
            appKitFrame: CGRect(x: -1000, y: 100, width: 1000, height: 800)
        )
        let selection = CGRect(x: -900, y: 100, width: 80, height: 18)

        let target = try XCTUnwrap(AXPanelPlacement.targetDisplay(forAXBounds: selection, displays: [primary, leftDisplay]))
        let frame = try XCTUnwrap(AXPanelPlacement.frame(
            forAXBounds: selection,
            displays: [primary, leftDisplay],
            panelSize: CGSize(width: 320, height: 200),
            gap: 10
        ))

        XCTAssertEqual(target, leftDisplay)
        XCTAssertTrue(leftDisplay.appKitFrame.contains(frame))
        XCTAssertFalse(primary.appKitFrame.contains(frame))
    }

    func testCoordinateConversionAndClampingHandleNegativeScreenOrigins() throws {
        let display = AXDisplayGeometry(
            axFrame: CGRect(x: -900, y: 0, width: 900, height: 700),
            appKitFrame: CGRect(x: -900, y: -400, width: 900, height: 700)
        )
        let selection = CGRect(x: -30, y: 670, width: 30, height: 20)

        let frame = try XCTUnwrap(AXPanelPlacement.frame(
            forAXBounds: selection,
            displays: [display],
            panelSize: CGSize(width: 300, height: 200),
            gap: 8
        ))

        XCTAssertEqual(frame, CGRect(x: -300, y: -400, width: 300, height: 200))
        XCTAssertTrue(display.appKitFrame.contains(frame))
    }

    func testReturnsNoPlacementWhenSelectionDoesNotIntersectAnyDisplay() {
        let display = AXDisplayGeometry(
            axFrame: CGRect(x: 0, y: 0, width: 1440, height: 900),
            appKitFrame: CGRect(x: 0, y: 0, width: 1440, height: 900)
        )

        XCTAssertNil(AXPanelPlacement.frame(
            forAXBounds: CGRect(x: 2000, y: 2000, width: 100, height: 20),
            displays: [display],
            panelSize: CGSize(width: 320, height: 200)
        ))
    }

    @MainActor
    func testPanelIsNonActivatingAndCannotBecomeKeyOrMain() {
        let panel = NonActivatingCapturePanel(
            contentRect: CGRect(x: 0, y: 0, width: 320, height: 200)
        )

        XCTAssertTrue(panel.styleMask.contains(.nonactivatingPanel))
        XCTAssertFalse(panel.canBecomeKey)
        XCTAssertFalse(panel.canBecomeMain)
        XCTAssertEqual(panel.level, .floating)
        XCTAssertFalse(panel.hidesOnDeactivate)
    }
}
