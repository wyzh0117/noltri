import ApplicationServices
import CoreGraphics
import Foundation

public struct AXSelectionSnapshot: Equatable {
    public let processID: pid_t
    public let text: String
    public let selectionRange: NSRange
    public let bounds: CGRect

    public init(processID: pid_t, text: String, selectionRange: NSRange, bounds: CGRect) {
        self.processID = processID
        self.text = text
        self.selectionRange = selectionRange
        self.bounds = bounds
    }
}

public protocol AXElementAPI {
    associatedtype Element

    func focusedElement(processID: pid_t) -> Element?
    func selectedText(for element: Element) -> String?
    func selectedRange(for element: Element) -> NSRange?
    func bounds(for element: Element, range: NSRange) -> CGRect?
}

public struct AXSelectionReader<API: AXElementAPI> {
    private let api: API
    private let isAccessibilityTrusted: () -> Bool

    public init(
        api: API,
        isAccessibilityTrusted: @escaping () -> Bool = { AXTrust.checkWithoutPrompt() }
    ) {
        self.api = api
        self.isAccessibilityTrusted = isAccessibilityTrusted
    }

    public func read(processID: pid_t) -> AXSelectionSnapshot? {
        guard processID > 0,
              isAccessibilityTrusted(),
              let element = api.focusedElement(processID: processID),
              let text = api.selectedText(for: element),
              !text.isEmpty,
              let range = api.selectedRange(for: element),
              range.length > 0,
              let bounds = api.bounds(for: element, range: range),
              !bounds.isNull,
              !bounds.isInfinite,
              bounds.width > 0,
              bounds.height > 0
        else { return nil }

        return AXSelectionSnapshot(
            processID: processID,
            text: text,
            selectionRange: range,
            bounds: bounds
        )
    }
}

public enum AXProbeCommand: Equatable {
    case checkTrust
    case exerciseOwnedFixture

    public static func parse(_ arguments: [String]) -> AXProbeCommand? {
        switch arguments {
        case ["--check-trust"]:
            return .checkTrust
        case ["--exercise"]:
            return .exerciseOwnedFixture
        default:
            return nil
        }
    }
}

public enum AXOwnedFixtureReadGate {
    public static func readIfReady<Snapshot>(
        processID: pid_t,
        childIsRunning: Bool,
        readySignalReceived: Bool,
        using readAX: (pid_t) -> Snapshot?
    ) -> Snapshot? {
        guard processID > 0, childIsRunning, readySignalReceived else { return nil }
        return readAX(processID)
    }
}

public struct MacAXElementAPI: AXElementAPI {
    public struct Element {
        fileprivate let raw: AXUIElement
    }

    public init() {}

    public func focusedElement(processID: pid_t) -> Element? {
        let application = AXUIElementCreateApplication(processID)
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(
            application,
            kAXFocusedUIElementAttribute as CFString,
            &value
        ) == .success,
        let value,
        CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
        return Element(raw: unsafeDowncast(value, to: AXUIElement.self))
    }

    public func selectedText(for element: Element) -> String? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(
            element.raw,
            kAXSelectedTextAttribute as CFString,
            &value
        ) == .success else { return nil }
        return value as? String
    }

    public func selectedRange(for element: Element) -> NSRange? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(
            element.raw,
            kAXSelectedTextRangeAttribute as CFString,
            &value
        ) == .success,
        let value,
        CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
        let axValue = unsafeDowncast(value, to: AXValue.self)
        guard AXValueGetType(axValue) == .cfRange else { return nil }

        var range = CFRange()
        guard AXValueGetValue(axValue, .cfRange, &range) else { return nil }
        return NSRange(location: range.location, length: range.length)
    }

    public func bounds(for element: Element, range: NSRange) -> CGRect? {
        var cfRange = CFRange(location: range.location, length: range.length)
        guard let rangeValue = AXValueCreate(.cfRange, &cfRange) else { return nil }

        var value: CFTypeRef?
        guard AXUIElementCopyParameterizedAttributeValue(
            element.raw,
            kAXBoundsForRangeParameterizedAttribute as CFString,
            rangeValue,
            &value
        ) == .success,
        let value,
        CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
        let axValue = unsafeDowncast(value, to: AXValue.self)
        guard AXValueGetType(axValue) == .cgRect else { return nil }

        var rect = CGRect.zero
        guard AXValueGetValue(axValue, .cgRect, &rect) else { return nil }
        return rect
    }
}

public enum AXTrust {
    /// Checks only the current process. The prompt option is hard-coded false.
    public static func checkWithoutPrompt() -> Bool {
        // This matches kAXTrustedCheckOptionPrompt's value from AXUIElement.h.
        return AXIsProcessTrustedWithOptions(["AXTrustedCheckOptionPrompt": false] as CFDictionary)
    }
}
