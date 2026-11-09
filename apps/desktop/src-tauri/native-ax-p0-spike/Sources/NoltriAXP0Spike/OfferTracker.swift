import Foundation

public struct AXSelectionOffer: Equatable {
    public let requestID: String
    public let snapshot: AXSelectionSnapshot
    public let bundleIdentifier: String
    public let applicationName: String

    public init(requestID: String, snapshot: AXSelectionSnapshot, bundleIdentifier: String, applicationName: String) {
        self.requestID = requestID
        self.snapshot = snapshot
        self.bundleIdentifier = bundleIdentifier
        self.applicationName = applicationName
    }
}

public enum AXOfferUpdate: Equatable {
    case none
    case presented(AXSelectionOffer)
    case moved(AXSelectionOffer)
    case cancelled(String)
}

private struct SelectionIdentity: Equatable {
    let processID: pid_t
    let focusedElementIdentity: String
    let text: String
    let range: NSRange
    let bundleIdentifier: String

    init(snapshot: AXSelectionSnapshot, bundleIdentifier: String) {
        processID = snapshot.processID
        focusedElementIdentity = snapshot.focusedElementIdentity
        text = snapshot.text
        range = snapshot.selectionRange
        self.bundleIdentifier = bundleIdentifier
    }
}

/// Debounces one foreground selection and makes acceptance a one-shot exact-snapshot check.
public final class AXSelectionOfferTracker {
    private let stabilityInterval: TimeInterval
    private let makeRequestID: () -> String
    private var candidate: (identity: SelectionIdentity, startedAt: Date, snapshot: AXSelectionSnapshot, bundleIdentifier: String, applicationName: String)?
    private var offer: AXSelectionOffer?
    private var consumedIdentity: SelectionIdentity?

    public init(stabilityInterval: TimeInterval = 0.35, makeRequestID: @escaping () -> String = { "ax-" + UUID().uuidString.lowercased() }) {
        self.stabilityInterval = max(0, stabilityInterval.isFinite ? stabilityInterval : 0.35)
        self.makeRequestID = makeRequestID
    }

    public func observe(
        snapshot: AXSelectionSnapshot?,
        bundleIdentifier: String?,
        applicationName: String?,
        now: Date = Date()
    ) -> AXOfferUpdate {
        guard let snapshot,
              let bundleIdentifier, !bundleIdentifier.isEmpty,
              let applicationName, !applicationName.isEmpty,
              snapshot.processID > 0,
              !snapshot.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              snapshot.selectionRange.length > 0,
              snapshot.bounds.width > 0, snapshot.bounds.height > 0 else {
            candidate = nil
            guard let old = offer else { return .none }
            offer = nil
            return .cancelled(old.requestID)
        }

        let identity = SelectionIdentity(snapshot: snapshot, bundleIdentifier: bundleIdentifier)
        if identity == consumedIdentity { return .none }
        if consumedIdentity != nil { consumedIdentity = nil }

        if let current = offer {
            guard SelectionIdentity(snapshot: current.snapshot, bundleIdentifier: current.bundleIdentifier) == identity else {
                offer = nil
                candidate = (identity, now, snapshot, bundleIdentifier, applicationName)
                return .cancelled(current.requestID)
            }
            let moved = AXSelectionOffer(requestID: current.requestID, snapshot: snapshot, bundleIdentifier: bundleIdentifier, applicationName: applicationName)
            offer = moved
            return current.snapshot.bounds == snapshot.bounds && current.applicationName == applicationName ? .none : .moved(moved)
        }

        guard let current = candidate, current.identity == identity else {
            candidate = (identity, now, snapshot, bundleIdentifier, applicationName)
            return .none
        }

        candidate = (identity, current.startedAt, snapshot, bundleIdentifier, applicationName)
        guard now.timeIntervalSince(current.startedAt) >= stabilityInterval else { return .none }
        let next = AXSelectionOffer(requestID: makeRequestID(), snapshot: snapshot, bundleIdentifier: bundleIdentifier, applicationName: applicationName)
        candidate = nil
        offer = next
        return .presented(next)
    }

    public func accept(requestID: String, currentSnapshot: AXSelectionSnapshot?, currentBundleIdentifier: String?) -> AXSelectionOffer? {
        guard let offer, offer.requestID == requestID,
              let currentSnapshot, let currentBundleIdentifier,
              SelectionIdentity(snapshot: offer.snapshot, bundleIdentifier: offer.bundleIdentifier)
                == SelectionIdentity(snapshot: currentSnapshot, bundleIdentifier: currentBundleIdentifier)
        else {
            self.offer = nil
            candidate = nil
            return nil
        }
        self.offer = nil
        candidate = nil
        consumedIdentity = SelectionIdentity(snapshot: currentSnapshot, bundleIdentifier: currentBundleIdentifier)
        return AXSelectionOffer(requestID: offer.requestID, snapshot: currentSnapshot, bundleIdentifier: currentBundleIdentifier, applicationName: offer.applicationName)
    }

    public func reset() -> String? {
        candidate = nil
        consumedIdentity = nil
        defer { offer = nil }
        return offer?.requestID
    }
}
