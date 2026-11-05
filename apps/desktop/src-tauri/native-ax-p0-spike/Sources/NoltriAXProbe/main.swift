import AppKit
import CoreGraphics
import Foundation
import NoltriAXP0Spike

private let expectedSelection = "Noltri AX selection sentinel"

@main
struct NoltriAXProbe {
    static func main() async {
        let binaryPath = URL(fileURLWithPath: CommandLine.arguments[0]).standardizedFileURL.path
        let arguments = Array(CommandLine.arguments.dropFirst())

        guard let command = AXProbeCommand.parse(arguments) else {
            fputs("usage: noltri-ax-p0-probe --check-trust | --exercise\n", stderr)
            return
        }

        switch command {
        case .checkTrust:
            printJSON([
                "accessibilityTrusted": AXTrust.checkWithoutPrompt(),
                "promptRequested": false,
                "binaryPath": binaryPath,
            ])
        case .exerciseOwnedFixture:
            guard AXTrust.checkWithoutPrompt() else {
                printJSON([
                    "accessibilityTrusted": false,
                    "promptRequested": false,
                    "requiredPermission": "Accessibility",
                    "binaryPath": binaryPath,
                    "exercise": "skipped",
                ])
                return
            }

            await MainActor.run { exerciseOwnedFixture(binaryPath: binaryPath) }
        }
    }

    @MainActor
    private static func exerciseOwnedFixture(binaryPath: String) {
        let probeURL = URL(fileURLWithPath: binaryPath).standardizedFileURL
        let fixtureURL = probeURL.deletingLastPathComponent().appendingPathComponent("noltri-ax-p0-fixture")
        guard fixtureURL.lastPathComponent == "noltri-ax-p0-fixture",
              FileManager.default.isExecutableFile(atPath: fixtureURL.path)
        else {
            printJSON([
                "accessibilityTrusted": true,
                "binaryPath": binaryPath,
                "syntheticSelectionReadable": false,
                "reason": "owned synthetic fixture executable is unavailable beside the probe",
            ])
            return
        }

        let fixture = Process()
        let outputPipe = Pipe()
        fixture.executableURL = fixtureURL
        fixture.arguments = []
        fixture.standardOutput = outputPipe
        fixture.standardError = FileHandle.nullDevice

        do {
            try fixture.run()
            try? outputPipe.fileHandleForWriting.close()
        } catch {
            try? outputPipe.fileHandleForReading.close()
            try? outputPipe.fileHandleForWriting.close()
            printJSON([
                "accessibilityTrusted": true,
                "binaryPath": binaryPath,
                "syntheticSelectionReadable": false,
                "reason": "owned synthetic fixture could not be started",
            ])
            return
        }
        defer {
            let cleanup = OwnedFixtureProcessCleanup.terminate(
                fixture,
                outputReader: outputPipe.fileHandleForReading,
                gracePeriod: 0.5,
                forcePeriod: 0.5
            )
            if !cleanup.exited {
                fputs("owned synthetic fixture did not exit after bounded termination\n", stderr)
            }
        }

        // The PID comes only from the child Process just launched above. No
        // caller-supplied PID or frontmost application is ever queried.
        let ownedFixturePID = fixture.processIdentifier
        let readySignalReceived = ownedFixturePID > 0
            && OwnedFixtureReadySignal.wait(from: outputPipe.fileHandleForReading, timeout: 5)
        exercise(
            processID: ownedFixturePID,
            childIsRunning: fixture.isRunning,
            readySignalReceived: readySignalReceived,
            binaryPath: binaryPath
        )
    }

    @MainActor
    private static func exercise(
        processID: pid_t,
        childIsRunning: Bool,
        readySignalReceived: Bool,
        binaryPath: String
    ) {
        let reader = AXSelectionReader(api: MacAXElementAPI())
        guard let before = AXOwnedFixtureReadGate.readIfReady(
            processID: processID,
            childIsRunning: childIsRunning,
            readySignalReceived: readySignalReceived,
            using: { reader.read(processID: $0) }
        ) else {
            printJSON([
                "accessibilityTrusted": true,
                "binaryPath": binaryPath,
                "syntheticSelectionReadable": false,
                "reason": readySignalReceived
                    ? "owned fixture ended before AX selection read"
                    : "owned synthetic fixture did not report ready within five seconds",
            ])
            return
        }

        guard before.text == expectedSelection else {
            printJSON([
                "accessibilityTrusted": true,
                "binaryPath": binaryPath,
                "syntheticSelectionReadable": false,
                "expectedSyntheticTextMatched": false,
            ])
            return
        }

        let displays = displayGeometries()
        guard let panelFrame = AXPanelPlacement.frame(
            forAXBounds: before.bounds,
            displays: displays,
            panelSize: CGSize(width: 320, height: 92),
            gap: 10
        ) else {
            printJSON([
                "accessibilityTrusted": true,
                "binaryPath": binaryPath,
                "syntheticSelectionReadable": true,
                "expectedSyntheticTextMatched": true,
                "panelPlacementAvailable": false,
            ])
            return
        }

        NSApplication.shared.setActivationPolicy(.accessory)
        let panel = NonActivatingCapturePanel(contentRect: panelFrame)
        let content = NSView(frame: CGRect(origin: .zero, size: panelFrame.size))
        let label = NSTextField(labelWithString: "Noltri synthetic AX test panel")
        label.frame = CGRect(x: 16, y: 36, width: 288, height: 20)
        content.addSubview(label)
        panel.contentView = content
        panel.orderFrontRegardless()
        RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.25))

        let after = reader.read(processID: processID)
        let selectionTextAndRangeUnchanged = after?.text == before.text
            && after?.selectionRange == before.selectionRange
        let result: [String: Any] = [
            "accessibilityTrusted": true,
            "binaryPath": binaryPath,
            "syntheticSelectionReadable": true,
            "expectedSyntheticTextMatched": true,
            "selectionBounds": [before.bounds.origin.x, before.bounds.origin.y, before.bounds.width, before.bounds.height],
            "panelVisible": panel.isVisible,
            "panelFrame": [panel.frame.origin.x, panel.frame.origin.y, panel.frame.width, panel.frame.height],
            "panelNonActivatingStyle": panel.styleMask.contains(.nonactivatingPanel),
            "panelCanBecomeKey": panel.canBecomeKey,
            "probeActivated": NSApplication.shared.isActive,
            "selectionTextAndRangeUnchanged": selectionTextAndRangeUnchanged,
            "focusPreservationStatus": "not_verified",
        ]
        panel.close()
        printJSON(result)
    }

    @MainActor
    private static func displayGeometries() -> [AXDisplayGeometry] {
        NSScreen.screens.compactMap { screen in
            guard let number = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber else {
                return nil
            }
            let displayID = CGDirectDisplayID(number.uint32Value)
            let axFrame = CGDisplayBounds(displayID)
            guard axFrame.width > 0, axFrame.height > 0 else { return nil }
            return AXDisplayGeometry(axFrame: axFrame, appKitFrame: screen.frame)
        }
    }

    private static func printJSON(_ value: [String: Any]) {
        guard JSONSerialization.isValidJSONObject(value),
              let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]),
              let output = String(data: data, encoding: .utf8) else {
            print("{}")
            return
        }
        print(output)
    }
}
