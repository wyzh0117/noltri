import AppKit
import CoreGraphics

@MainActor
final class SelectionOfferPanel: NonActivatingCapturePanel {
    private let heading = NSTextField(labelWithString: "收集选中文字")
    private let selection = NSTextField(wrappingLabelWithString: "")
    private let collectButton = NSButton(title: "收集", target: nil, action: nil)
    private let dismissButton = NSButton(title: "关闭", target: nil, action: nil)
    private var requestID: String?
    var onAccept: ((String) -> Void)?

    init() {
        super.init(contentRect: CGRect(x: 0, y: 0, width: 340, height: 112))
        isFloatingPanel = true
        hasShadow = true
        contentView?.wantsLayer = true
        contentView?.layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor
        contentView?.layer?.cornerRadius = 12

        heading.font = .systemFont(ofSize: 13, weight: .semibold)
        heading.frame = CGRect(x: 14, y: 84, width: 310, height: 18)
        selection.font = .systemFont(ofSize: 12)
        selection.maximumNumberOfLines = 2
        selection.lineBreakMode = .byTruncatingTail
        selection.frame = CGRect(x: 14, y: 40, width: 312, height: 38)

        collectButton.bezelStyle = .rounded
        collectButton.target = self
        collectButton.action = #selector(acceptSelection(_:))
        collectButton.frame = CGRect(x: 246, y: 8, width: 80, height: 26)
        dismissButton.bezelStyle = .rounded
        dismissButton.target = self
        dismissButton.action = #selector(dismissSelection(_:))
        dismissButton.frame = CGRect(x: 158, y: 8, width: 80, height: 26)

        contentView?.addSubview(heading)
        contentView?.addSubview(selection)
        contentView?.addSubview(dismissButton)
        contentView?.addSubview(collectButton)
    }

    func present(_ offer: AXSelectionOffer, onAccept: @escaping (String) -> Void) {
        requestID = offer.requestID
        self.onAccept = onAccept
        selection.stringValue = String(offer.snapshot.text.prefix(240))

        let displays = NSScreen.screens.compactMap { screen -> AXDisplayGeometry? in
            guard let number = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber else { return nil }
            return AXDisplayGeometry(
                axFrame: CGDisplayBounds(CGDirectDisplayID(number.uint32Value)),
                appKitFrame: screen.frame
            )
        }
        guard let frame = AXPanelPlacement.frame(
            forAXBounds: offer.snapshot.bounds,
            displays: displays,
            panelSize: self.frame.size
        ) else {
            orderOut(nil)
            return
        }
        setFrame(frame, display: true)
        orderFrontRegardless()
    }

    func dismiss() {
        requestID = nil
        onAccept = nil
        orderOut(nil)
    }

    @objc private func acceptSelection(_ sender: NSButton) {
        guard let requestID else { return }
        onAccept?(requestID)
    }

    @objc private func dismissSelection(_ sender: NSButton) {
        dismiss()
        // Dismissal consumes this visible offer; no capture is submitted.
    }
}
