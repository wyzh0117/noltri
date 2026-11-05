import Foundation

public struct SyntheticFixtureFocusSnapshot: Codable, Equatable {
    public let processID: Int32
    public let uptimeNanoseconds: UInt64
    public let event: String
    public let applicationIsActive: Bool
    public let keyWindowIdentifier: String?
    public let firstResponderIdentifier: String?
    public let syntheticWindowIsKey: Bool
    public let syntheticTextViewIsFirstResponder: Bool

    public init(
        processID: Int32,
        uptimeNanoseconds: UInt64,
        event: String,
        applicationIsActive: Bool,
        keyWindowIdentifier: String?,
        firstResponderIdentifier: String?,
        syntheticWindowIsKey: Bool,
        syntheticTextViewIsFirstResponder: Bool
    ) {
        self.processID = processID
        self.uptimeNanoseconds = uptimeNanoseconds
        self.event = event
        self.applicationIsActive = applicationIsActive
        self.keyWindowIdentifier = keyWindowIdentifier
        self.firstResponderIdentifier = firstResponderIdentifier
        self.syntheticWindowIsKey = syntheticWindowIsKey
        self.syntheticTextViewIsFirstResponder = syntheticTextViewIsFirstResponder
    }

    public func preservesFocusedTarget(from baseline: Self) -> Bool {
        processID == baseline.processID
            && applicationIsActive
            && baseline.applicationIsActive
            && syntheticWindowIsKey
            && baseline.syntheticWindowIsKey
            && syntheticTextViewIsFirstResponder
            && baseline.syntheticTextViewIsFirstResponder
            && keyWindowIdentifier != nil
            && keyWindowIdentifier == baseline.keyWindowIdentifier
            && firstResponderIdentifier != nil
            && firstResponderIdentifier == baseline.firstResponderIdentifier
    }
}

public enum SyntheticFixtureFocusTimeline {
    public static func preservesFocus(
        _ snapshots: [SyntheticFixtureFocusSnapshot],
        minimumObservedNanoseconds: UInt64
    ) -> Bool {
        guard let baseline = snapshots.first,
              baseline.event == "ready",
              let final = snapshots.last,
              final.event == "sample",
              final.uptimeNanoseconds >= baseline.uptimeNanoseconds,
              final.uptimeNanoseconds - baseline.uptimeNanoseconds >= minimumObservedNanoseconds,
              snapshots.count >= 2
        else { return false }

        return snapshots.dropFirst().allSatisfy { $0.preservesFocusedTarget(from: baseline) }
    }
}

@MainActor
public final class SyntheticFixtureFocusLog {
    private let fileHandle: FileHandle
    private let encoder = JSONEncoder()

    public init(url: URL) throws {
        let temporaryDirectory = FileManager.default.temporaryDirectory
            .standardizedFileURL
            .resolvingSymlinksInPath()
        let logURL = url.standardizedFileURL
        let logDirectory = logURL.deletingLastPathComponent().resolvingSymlinksInPath()
        let temporaryPrefix = temporaryDirectory.path.hasSuffix("/")
            ? temporaryDirectory.path
            : temporaryDirectory.path + "/"
        let captureDirectoryName = logDirectory.lastPathComponent

        guard logDirectory.path.hasPrefix(temporaryPrefix),
              captureDirectoryName.hasPrefix("noltri-ax-p0-focus-"),
              logURL.lastPathComponent == "fixture-focus.jsonl",
              !FileManager.default.fileExists(atPath: logURL.path),
              FileManager.default.createFile(
                  atPath: logURL.path,
                  contents: nil,
                  attributes: [.posixPermissions: 0o600]
              )
        else { throw SyntheticFixtureFocusLogError.invalidLogPath }

        fileHandle = try FileHandle(forWritingTo: logURL)
        encoder.outputFormatting = [.sortedKeys]
    }

    public func append(_ snapshot: SyntheticFixtureFocusSnapshot) throws {
        var data = try encoder.encode(snapshot)
        data.append(0x0A)
        fileHandle.write(data)
    }

    public func close() throws {
        try fileHandle.close()
    }
}

public enum SyntheticFixtureFocusLogError: Error, Equatable {
    case invalidLogPath
}
