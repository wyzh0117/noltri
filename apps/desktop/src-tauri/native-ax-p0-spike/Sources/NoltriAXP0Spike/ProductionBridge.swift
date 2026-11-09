import AppKit
import Foundation

public typealias AXOfferBridgeCallback = @convention(c) (UnsafeMutableRawPointer?, UnsafePointer<CChar>?) -> Void

private let axOfferEnabledKey = "noltri.axSelectionOffersEnabled"

private struct AXOfferCallbackBridge: @unchecked Sendable {
    let context: UnsafeMutableRawPointer?
    let callback: AXOfferBridgeCallback
}

@MainActor
private final class AXSelectionOfferService {
    static let shared = AXSelectionOfferService()

    private let tracker = AXSelectionOfferTracker()
    private let reader = AXSelectionReader(api: MacAXElementAPI())
    private var timer: Timer?
    private var panel: SelectionOfferPanel?
    private var callbackBridge: AXOfferCallbackBridge?

    func start(bridge: AXOfferCallbackBridge) -> Bool {
        guard Thread.isMainThread, AXTrust.checkWithoutPrompt() else { return false }
        if timer != nil { return true }
        callbackBridge = bridge
        let timer = Timer(timeInterval: 0.1, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.refresh() }
        }
        self.timer = timer
        RunLoop.main.add(timer, forMode: .common)
        refresh()
        return true
    }

    func stop() {
        timer?.invalidate()
        timer = nil
        _ = tracker.reset()
        panel?.dismiss()
        panel = nil
        callbackBridge = nil
    }

    private func foregroundSelection() -> (AXSelectionSnapshot?, String?, String?) {
        guard let application = NSWorkspace.shared.frontmostApplication,
              let bundleIdentifier = application.bundleIdentifier,
              AXSupportedApplications.contains(bundleIdentifier) else { return (nil, nil, nil) }
        let snapshot = reader.read(processID: application.processIdentifier)
        return (snapshot, bundleIdentifier, application.localizedName)
    }

    private func refresh() {
        let (snapshot, bundleIdentifier, applicationName) = foregroundSelection()
        switch tracker.observe(
            snapshot: snapshot,
            bundleIdentifier: bundleIdentifier,
            applicationName: applicationName
        ) {
        case .presented(let offer), .moved(let offer):
            if panel == nil { panel = SelectionOfferPanel() }
            panel?.present(offer) { [weak self] requestID in self?.accept(requestID: requestID) }
        case .cancelled:
            panel?.dismiss()
        case .none:
            break
        }
    }

    private func accept(requestID: String) {
        let (snapshot, bundleIdentifier, _) = foregroundSelection()
        guard let offer = tracker.accept(
            requestID: requestID,
            currentSnapshot: snapshot,
            currentBundleIdentifier: bundleIdentifier
        ) else {
            panel?.dismiss()
            return
        }
        panel?.dismiss()
        sendAccepted(offer)
    }

    private func sendAccepted(_ offer: AXSelectionOffer) {
        guard let callbackBridge, let callbackContext = callbackBridge.context else { return }
        let payload: [String: String] = [
            "kind": "accepted",
            "requestId": offer.requestID,
            "text": offer.snapshot.text,
            "appName": offer.applicationName,
            "bundleId": offer.bundleIdentifier,
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let message = String(data: data, encoding: .utf8) else { return }
        message.withCString { callbackBridge.callback(callbackContext, $0) }
    }
}

@_cdecl("noltri_ax_offer_is_enabled")
public func noltriAXOfferIsEnabled() -> Int32 {
    UserDefaults.standard.bool(forKey: axOfferEnabledKey) ? 1 : 0
}

@_cdecl("noltri_ax_offer_check_trust")
public func noltriAXOfferCheckTrust() -> Int32 {
    AXTrust.checkWithoutPrompt() ? 1 : 0
}

/// Returns 1 when running, 0 when default-off, and -1 when permission is denied.
@_cdecl("noltri_ax_offer_start_if_enabled")
public func noltriAXOfferStartIfEnabled(
    _ context: UnsafeMutableRawPointer?,
    _ callback: AXOfferBridgeCallback
) -> Int32 {
    guard UserDefaults.standard.bool(forKey: axOfferEnabledKey) else { return 0 }
    guard AXTrust.checkWithoutPrompt() else { return -1 }
    let bridge = AXOfferCallbackBridge(context: context, callback: callback)
    return MainActor.assumeIsolated {
        AXSelectionOfferService.shared.start(bridge: bridge) ? 1 : -1
    }
}

/// Enable is only persisted after the no-prompt trust check succeeds.
@_cdecl("noltri_ax_offer_set_enabled")
public func noltriAXOfferSetEnabled(
    _ enabled: Int32,
    _ context: UnsafeMutableRawPointer?,
    _ callback: AXOfferBridgeCallback
) -> Int32 {
    guard Thread.isMainThread else { return -2 }
    if enabled == 0 {
        UserDefaults.standard.set(false, forKey: axOfferEnabledKey)
        MainActor.assumeIsolated { AXSelectionOfferService.shared.stop() }
        return 0
    }
    guard AXTrust.checkWithoutPrompt() else { return -1 }
    let bridge = AXOfferCallbackBridge(context: context, callback: callback)
    let started = MainActor.assumeIsolated {
        AXSelectionOfferService.shared.start(bridge: bridge)
    }
    guard started else { return -2 }
    UserDefaults.standard.set(true, forKey: axOfferEnabledKey)
    return 1
}

@_cdecl("noltri_ax_offer_stop")
public func noltriAXOfferStop() {
    guard Thread.isMainThread else { return }
    MainActor.assumeIsolated { AXSelectionOfferService.shared.stop() }
}
