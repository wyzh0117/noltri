import AppKit
import Darwin
import Foundation
import NoltriAXP0Spike

private let sentinel = "Noltri AX selection sentinel"
private let windowIdentifier = "noltri-ax-p0-synthetic-window"
private let textViewIdentifier = "noltri-ax-p0-synthetic-text-view"

@MainActor
private final class SyntheticFocusSampler: NSObject {
    private let app: NSApplication
    private let window: NSWindow
    private let textView: NSTextView
    private let log: SyntheticFixtureFocusLog
    private var timer: Timer?

    init(app: NSApplication, window: NSWindow, textView: NSTextView, log: SyntheticFixtureFocusLog) {
        self.app = app
        self.window = window
        self.textView = textView
        self.log = log
    }

    func start() {
        record(event: "ready")
        let timer = Timer(
            timeInterval: 0.01,
            target: self,
            selector: #selector(recordSample(_:)),
            userInfo: nil,
            repeats: true
        )
        self.timer = timer
        RunLoop.main.add(timer, forMode: .common)
    }

    @objc private func recordSample(_ timer: Timer) {
        record(event: "sample")
    }

    private func record(event: String) {
        let firstResponder = window.firstResponder as? NSView
        let snapshot = SyntheticFixtureFocusSnapshot(
            processID: Int32(getpid()),
            uptimeNanoseconds: DispatchTime.now().uptimeNanoseconds,
            event: event,
            applicationIsActive: app.isActive,
            keyWindowIdentifier: app.keyWindow?.identifier?.rawValue,
            firstResponderIdentifier: firstResponder?.identifier?.rawValue,
            syntheticWindowIsKey: window.isKeyWindow,
            syntheticTextViewIsFirstResponder: window.firstResponder === textView
        )
        try? log.append(snapshot)
    }
}

@main
struct NoltriAXFixture {
    @MainActor
    static func main() {
        let app = NSApplication.shared
        app.setActivationPolicy(.regular)

        let text = "Synthetic fixture only. Select this fixed phrase: \(sentinel)."
        let textView = NSTextView(frame: CGRect(x: 0, y: 0, width: 680, height: 160))
        textView.string = text
        textView.isEditable = false
        textView.isSelectable = true
        textView.identifier = NSUserInterfaceItemIdentifier(textViewIdentifier)

        let window = NSWindow(
            contentRect: CGRect(x: 240, y: 260, width: 720, height: 220),
            styleMask: [.titled, .closable, .miniaturizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Noltri AX P0 Synthetic Fixture"
        window.identifier = NSUserInterfaceItemIdentifier(windowIdentifier)
        window.contentView = textView
        window.makeKeyAndOrderFront(nil)
        app.activate(ignoringOtherApps: true)
        window.makeFirstResponder(textView)
        textView.setSelectedRange((text as NSString).range(of: sentinel))

        let focusSampler: SyntheticFocusSampler?
        if let path = ProcessInfo.processInfo.environment["NOLTRI_AX_P0_FOCUS_LOG"] {
            do {
                let log = try SyntheticFixtureFocusLog(url: URL(fileURLWithPath: path))
                focusSampler = SyntheticFocusSampler(app: app, window: window, textView: textView, log: log)
            } catch {
                fputs("synthetic focus log path rejected\n", stderr)
                return
            }
        } else {
            focusSampler = nil
        }

        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
            focusSampler?.start()
            print("NOLTRI_AX_FIXTURE_READY")
            fflush(stdout)
        }
        app.run()
    }
}
