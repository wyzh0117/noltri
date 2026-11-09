import CoreGraphics
import Foundation
import XCTest
@testable import NoltriAXP0Spike

final class OfferTrackerTests: XCTestCase {
    func testStableForegroundSelectionGetsOneOfferAfterDebounce() {
        let start = Date(timeIntervalSince1970: 1_000)
        let tracker = AXSelectionOfferTracker(stabilityInterval: 0.35, makeRequestID: { "ax-first" })
        let selected = snapshot()

        XCTAssertEqual(tracker.observe(snapshot: selected, bundleIdentifier: "com.apple.TextEdit", applicationName: "TextEdit", now: start), .none)
        XCTAssertEqual(tracker.observe(snapshot: selected, bundleIdentifier: "com.apple.TextEdit", applicationName: "TextEdit", now: start.addingTimeInterval(0.34)), .none)
        guard case .presented(let offer) = tracker.observe(snapshot: selected, bundleIdentifier: "com.apple.TextEdit", applicationName: "TextEdit", now: start.addingTimeInterval(0.35)) else {
            return XCTFail("expected one stable selection offer")
        }

        XCTAssertEqual(offer.requestID, "ax-first")
        XCTAssertEqual(tracker.observe(snapshot: selected, bundleIdentifier: "com.apple.TextEdit", applicationName: "TextEdit", now: start.addingTimeInterval(1)), .none)
    }

    func testFocusRangeOrApplicationChangeCancelsBeforeShowingNextOffer() {
        let start = Date(timeIntervalSince1970: 2_000)
        var ids = ["ax-first", "ax-second"]
        let tracker = AXSelectionOfferTracker(stabilityInterval: 0.2, makeRequestID: { ids.removeFirst() })
        let selected = snapshot()
        _ = tracker.observe(snapshot: selected, bundleIdentifier: "com.apple.TextEdit", applicationName: "TextEdit", now: start)
        guard case .presented = tracker.observe(snapshot: selected, bundleIdentifier: "com.apple.TextEdit", applicationName: "TextEdit", now: start.addingTimeInterval(0.2)) else {
            return XCTFail("expected first offer")
        }

        let changedRange = snapshot(range: NSRange(location: 4, length: 12))
        XCTAssertEqual(tracker.observe(snapshot: changedRange, bundleIdentifier: "com.apple.TextEdit", applicationName: "TextEdit", now: start.addingTimeInterval(0.21)), .cancelled("ax-first"))
        XCTAssertEqual(tracker.observe(snapshot: changedRange, bundleIdentifier: "com.apple.Notes", applicationName: "Notes", now: start.addingTimeInterval(0.42)), .none)

        let noteSelection = snapshot(processID: 55, focusID: "notes-body")
        _ = tracker.observe(snapshot: noteSelection, bundleIdentifier: "com.apple.Notes", applicationName: "Notes", now: start.addingTimeInterval(0.43))
        guard case .presented(let next) = tracker.observe(snapshot: noteSelection, bundleIdentifier: "com.apple.Notes", applicationName: "Notes", now: start.addingTimeInterval(0.63)) else {
            return XCTFail("expected replacement offer only after a fresh stable interval")
        }
        XCTAssertEqual(next.requestID, "ax-second")
    }

    func testAcceptanceRequiresTheSameRequestAndExactCurrentSelectionAndConsumesOnce() {
        let start = Date(timeIntervalSince1970: 3_000)
        let selected = snapshot()
        let tracker = AXSelectionOfferTracker(stabilityInterval: 0, makeRequestID: { "ax-once" })
        _ = tracker.observe(snapshot: selected, bundleIdentifier: "com.apple.TextEdit", applicationName: "TextEdit", now: start)
        guard case .presented = tracker.observe(snapshot: selected, bundleIdentifier: "com.apple.TextEdit", applicationName: "TextEdit", now: start) else {
            return XCTFail("expected offer")
        }

        XCTAssertNil(tracker.accept(requestID: "ax-once", currentSnapshot: snapshot(text: "changed"), currentBundleIdentifier: "com.apple.TextEdit"))

        _ = tracker.observe(snapshot: selected, bundleIdentifier: "com.apple.TextEdit", applicationName: "TextEdit", now: start.addingTimeInterval(1))
        guard case .presented = tracker.observe(snapshot: selected, bundleIdentifier: "com.apple.TextEdit", applicationName: "TextEdit", now: start.addingTimeInterval(1)) else {
            return XCTFail("expected a new offer after the stale attempt cancelled the old one")
        }
        XCTAssertNotNil(tracker.accept(requestID: "ax-once", currentSnapshot: selected, currentBundleIdentifier: "com.apple.TextEdit"))
        XCTAssertNil(tracker.accept(requestID: "ax-once", currentSnapshot: selected, currentBundleIdentifier: "com.apple.TextEdit"))
        XCTAssertEqual(tracker.observe(snapshot: selected, bundleIdentifier: "com.apple.TextEdit", applicationName: "TextEdit", now: start.addingTimeInterval(2)), .none)
    }

    func testOnlyExplicitlyAllowlistedDesktopAppsAreObserved() {
        XCTAssertTrue(AXSupportedApplications.contains("com.apple.TextEdit"))
        XCTAssertTrue(AXSupportedApplications.contains("com.apple.Notes"))
        for browser in ["com.apple.Safari", "com.google.Chrome", "org.mozilla.firefox"] {
            XCTAssertFalse(AXSupportedApplications.contains(browser))
        }
        XCTAssertFalse(AXSupportedApplications.contains(nil))
    }

    private func snapshot(
        processID: pid_t = 42,
        focusID: String = "text-field",
        text: String = "Synthetic selected text",
        range: NSRange = NSRange(location: 0, length: 23)
    ) -> AXSelectionSnapshot {
        AXSelectionSnapshot(
            processID: processID,
            focusedElementIdentity: focusID,
            text: text,
            selectionRange: range,
            bounds: CGRect(x: 20, y: 30, width: 140, height: 20)
        )
    }
}
