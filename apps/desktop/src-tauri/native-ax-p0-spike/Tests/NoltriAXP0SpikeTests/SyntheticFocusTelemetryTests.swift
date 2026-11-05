import Foundation
import XCTest
@testable import NoltriAXP0Spike

final class SyntheticFocusTelemetryTests: XCTestCase {
    func testTimelineRequiresSameActiveFixtureWindowAndTextViewAcrossPanelInterval() {
        let ready = snapshot(event: "ready", uptime: 1_000_000_000)
        let afterPanel = snapshot(event: "sample", uptime: 1_300_000_000)

        XCTAssertTrue(SyntheticFixtureFocusTimeline.preservesFocus(
            [ready, afterPanel], minimumObservedNanoseconds: 200_000_000
        ))

        let lostFocus = snapshot(
            event: "sample",
            uptime: 1_200_000_000,
            applicationIsActive: false,
            keyWindowIdentifier: nil,
            firstResponderIdentifier: nil,
            syntheticWindowIsKey: false,
            syntheticTextViewIsFirstResponder: false
        )
        XCTAssertFalse(SyntheticFixtureFocusTimeline.preservesFocus(
            [ready, lostFocus, afterPanel], minimumObservedNanoseconds: 200_000_000
        ))
    }

    func testTimelineRejectsDifferentProcessOrChangedFocusIdentity() {
        let ready = snapshot(event: "ready", uptime: 1_000_000_000)
        let changedProcess = snapshot(event: "sample", uptime: 1_300_000_000, processID: 732)
        let changedWindow = snapshot(
            event: "sample",
            uptime: 1_300_000_000,
            keyWindowIdentifier: "other-window"
        )
        let changedResponder = snapshot(
            event: "sample",
            uptime: 1_300_000_000,
            firstResponderIdentifier: "other-responder"
        )
        let tooShort = snapshot(event: "sample", uptime: 1_100_000_000)

        for changed in [changedProcess, changedWindow, changedResponder, tooShort] {
            XCTAssertFalse(SyntheticFixtureFocusTimeline.preservesFocus(
                [ready, changed], minimumObservedNanoseconds: 200_000_000
            ))
        }
    }

    @MainActor
    func testTelemetryWritesFixtureIdentityAndRejectsPathsOutsideTemporaryCaptureDirectory() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("noltri-ax-p0-focus-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }

        let logURL = directory.appendingPathComponent("fixture-focus.jsonl")
        let log = try SyntheticFixtureFocusLog(url: logURL)
        let snapshot = snapshot(event: "ready", uptime: 1_000_000_000)
        try log.append(snapshot)
        try log.close()

        let bytes = try Data(contentsOf: logURL)
        XCTAssertEqual(bytes.last, 0x0A)
        let line = try XCTUnwrap(String(data: bytes.dropLast(), encoding: .utf8))
        let decoded = try JSONDecoder().decode(SyntheticFixtureFocusSnapshot.self, from: Data(line.utf8))
        XCTAssertEqual(decoded, snapshot)

        let outside = URL(fileURLWithPath: "/etc/noltri-ax-p0-focus-outside/fixture-focus.jsonl")
        XCTAssertThrowsError(try SyntheticFixtureFocusLog(url: outside))
        XCTAssertFalse(FileManager.default.fileExists(atPath: outside.path))
    }

    private func snapshot(
        event: String,
        uptime: UInt64,
        processID: Int32 = 731,
        applicationIsActive: Bool = true,
        keyWindowIdentifier: String? = "noltri-ax-p0-synthetic-window",
        firstResponderIdentifier: String? = "noltri-ax-p0-synthetic-text-view",
        syntheticWindowIsKey: Bool = true,
        syntheticTextViewIsFirstResponder: Bool = true
    ) -> SyntheticFixtureFocusSnapshot {
        SyntheticFixtureFocusSnapshot(
            processID: processID,
            uptimeNanoseconds: uptime,
            event: event,
            applicationIsActive: applicationIsActive,
            keyWindowIdentifier: keyWindowIdentifier,
            firstResponderIdentifier: firstResponderIdentifier,
            syntheticWindowIsKey: syntheticWindowIsKey,
            syntheticTextViewIsFirstResponder: syntheticTextViewIsFirstResponder
        )
    }
}
