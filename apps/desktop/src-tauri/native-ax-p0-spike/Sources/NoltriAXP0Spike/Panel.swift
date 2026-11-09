import AppKit
import CoreGraphics

public struct AXDisplayGeometry: Equatable {
    /// AX/Quartz display bounds in global top-left coordinates.
    public let axFrame: CGRect
    /// NSScreen bounds in global bottom-left coordinates.
    public let appKitFrame: CGRect

    public init(axFrame: CGRect, appKitFrame: CGRect) {
        self.axFrame = axFrame
        self.appKitFrame = appKitFrame
    }
}

public enum AXPanelPlacement {
    public static func targetDisplay(
        forAXBounds bounds: CGRect,
        displays: [AXDisplayGeometry]
    ) -> AXDisplayGeometry? {
        displays
            .compactMap { display -> (AXDisplayGeometry, CGFloat)? in
                guard display.axFrame.width > 0,
                      display.axFrame.height > 0,
                      display.appKitFrame.width > 0,
                      display.appKitFrame.height > 0
                else { return nil }

                let intersection = display.axFrame.intersection(bounds)
                guard !intersection.isNull, !intersection.isEmpty else { return nil }
                return (display, intersection.width * intersection.height)
            }
            .max { $0.1 < $1.1 }?
            .0
    }

    /// Selects the display under the AX selection, converts top-left global
    /// coordinates into that NSScreen's bottom-left frame, and clamps the panel.
    public static func frame(
        forAXBounds bounds: CGRect,
        displays: [AXDisplayGeometry],
        panelSize: CGSize,
        gap: CGFloat = 8
    ) -> CGRect? {
        guard let display = targetDisplay(forAXBounds: bounds, displays: displays),
              display.axFrame.width > 0,
              display.axFrame.height > 0,
              display.appKitFrame.width > 0,
              display.appKitFrame.height > 0
        else { return nil }

        let screenFrame = display.appKitFrame
        let scaleX = screenFrame.width / display.axFrame.width
        let scaleY = screenFrame.height / display.axFrame.height
        let selection = CGRect(
            x: screenFrame.minX + (bounds.minX - display.axFrame.minX) * scaleX,
            y: screenFrame.maxY - (bounds.minY - display.axFrame.minY) * scaleY - bounds.height * scaleY,
            width: bounds.width * scaleX,
            height: bounds.height * scaleY
        )
        let width = min(max(0, panelSize.width), screenFrame.width)
        let height = min(max(0, panelSize.height), screenFrame.height)
        let x = min(max(screenFrame.minX, selection.maxX + gap), screenFrame.maxX - width)
        let y = min(max(screenFrame.minY, selection.maxY - height), screenFrame.maxY - height)
        return CGRect(x: x, y: y, width: width, height: height)
    }
}

public class NonActivatingCapturePanel: NSPanel {
    public init(contentRect: CGRect) {
        super.init(
            contentRect: contentRect,
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        level = .floating
        hidesOnDeactivate = false
        isReleasedWhenClosed = false
    }

    public override var canBecomeKey: Bool { false }
    public override var canBecomeMain: Bool { false }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is unavailable")
    }
}
