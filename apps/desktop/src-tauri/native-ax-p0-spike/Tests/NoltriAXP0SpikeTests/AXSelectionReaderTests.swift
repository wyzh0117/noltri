import CoreGraphics
import Foundation
import XCTest
@testable import NoltriAXP0Spike

final class AXSelectionReaderTests: XCTestCase {
    func testReaderUsesOnlyExplicitProcessAndReturnsSelectionAndBounds() {
        let pid: pid_t = 4242
        let range = NSRange(location: 8, length: 14)
        let bounds = CGRect(x: 180, y: 220, width: 144, height: 18)
        let api = FakeAXAPI(text: "synthetic selection", range: range, bounds: bounds)
        let reader = AXSelectionReader(api: api, isAccessibilityTrusted: { true })

        let result = reader.read(processID: pid)

        XCTAssertEqual(result?.processID, pid)
        XCTAssertEqual(result?.text, "synthetic selection")
        XCTAssertEqual(result?.selectionRange, range)
        XCTAssertEqual(result?.bounds, bounds)
        XCTAssertEqual(api.requestedProcessID, pid)
        XCTAssertEqual(api.boundsRequestedRange, range)
        XCTAssertEqual(api.focusedElementCalls, 1)
    }

    func testReaderIgnoresMissingOrEmptySelectionBeforeAskingForBounds() {
        let api = FakeAXAPI(text: "", range: NSRange(location: 0, length: 0), bounds: .zero)
        let reader = AXSelectionReader(api: api, isAccessibilityTrusted: { true })

        let result = reader.read(processID: 4242)

        XCTAssertNil(result)
        XCTAssertNil(api.boundsRequestedRange)
    }

    func testReaderDoesNotCallAXWhenAccessibilityPermissionIsDenied() {
        let api = FakeAXAPI(text: "synthetic selection", range: NSRange(location: 0, length: 9), bounds: CGRect(x: 0, y: 0, width: 90, height: 18))
        let reader = AXSelectionReader(api: api, isAccessibilityTrusted: { false })

        let result = reader.read(processID: 4242)

        XCTAssertNil(result)
        XCTAssertEqual(api.focusedElementCalls, 0)
        XCTAssertEqual(api.selectedTextCalls, 0)
        XCTAssertEqual(api.selectedRangeCalls, 0)
        XCTAssertEqual(api.boundsCalls, 0)
    }
}

private final class FakeAXAPI: AXElementAPI {
    typealias Element = String

    let text: String?
    let range: NSRange?
    let rect: CGRect?
    var requestedProcessID: pid_t?
    var boundsRequestedRange: NSRange?
    var focusedElementCalls = 0
    var selectedTextCalls = 0
    var selectedRangeCalls = 0
    var boundsCalls = 0

    init(text: String?, range: NSRange?, bounds: CGRect?) {
        self.text = text
        self.range = range
        self.rect = bounds
    }

    func focusedElement(processID: pid_t) -> String? {
        focusedElementCalls += 1
        requestedProcessID = processID
        return "synthetic-focused-element"
    }

    func selectedText(for element: String) -> String? {
        selectedTextCalls += 1
        return text
    }

    func selectedRange(for element: String) -> NSRange? {
        selectedRangeCalls += 1
        return range
    }

    func bounds(for element: String, range: NSRange) -> CGRect? {
        boundsCalls += 1
        boundsRequestedRange = range
        return rect
    }
}
