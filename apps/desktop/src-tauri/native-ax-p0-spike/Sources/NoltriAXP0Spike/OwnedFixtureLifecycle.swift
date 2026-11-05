import Darwin
import Foundation

public enum OwnedFixtureReadySignal {
    public static func wait(from reader: FileHandle, timeout: TimeInterval) -> Bool {
        let semaphore = DispatchSemaphore(value: 0)
        let accumulator = ReadySignalAccumulator()
        DispatchQueue.global(qos: .userInitiated).async {
            while true {
                let data = reader.availableData
                if data.isEmpty { break }
                if accumulator.append(data) {
                    semaphore.signal()
                    return
                }
            }
            semaphore.signal()
        }

        let boundedTimeout = min(max(timeout.isFinite ? timeout : 0, 0), 10)
        return semaphore.wait(timeout: .now() + boundedTimeout) == .success && accumulator.isReady
    }
}

public enum OwnedFixtureProcessCleanup {
    public struct Result: Equatable {
        public let exited: Bool
        public let didForceTerminate: Bool

        public init(exited: Bool, didForceTerminate: Bool) {
            self.exited = exited
            self.didForceTerminate = didForceTerminate
        }
    }

    /// Sends SIGTERM, waits for a bounded grace period, then escalates only the
    /// PID belonging to the Process handle. Both waits are capped at one second.
    public static func terminate(
        _ process: Process,
        outputReader: FileHandle?,
        gracePeriod: TimeInterval = 0.5,
        forcePeriod: TimeInterval = 0.5
    ) -> Result {
        defer { try? outputReader?.close() }
        guard process.isRunning else { return Result(exited: true, didForceTerminate: false) }

        let processID = process.processIdentifier
        guard processID > 0 else { return Result(exited: false, didForceTerminate: false) }

        let exitSignal = DispatchSemaphore(value: 0)
        let previousTerminationHandler = process.terminationHandler
        process.terminationHandler = { terminatedProcess in
            previousTerminationHandler?(terminatedProcess)
            exitSignal.signal()
        }

        guard process.isRunning else { return Result(exited: true, didForceTerminate: false) }
        process.terminate()
        let grace = boundedWait(gracePeriod)
        if exitSignal.wait(timeout: .now() + grace) == .success || !process.isRunning {
            return Result(exited: true, didForceTerminate: false)
        }

        // processIdentifier comes directly from this Process. Never look up or
        // signal a PID supplied by a caller or found through process scanning.
        _ = Darwin.kill(processID, SIGKILL)
        let force = boundedWait(forcePeriod)
        let exited = exitSignal.wait(timeout: .now() + force) == .success || !process.isRunning
        return Result(exited: exited, didForceTerminate: true)
    }

    private static func boundedWait(_ value: TimeInterval) -> TimeInterval {
        min(max(value.isFinite ? value : 0, 0), 1)
    }
}

private final class ReadySignalAccumulator: @unchecked Sendable {
    private let lock = NSLock()
    private var data = Data()
    private let marker = Data("NOLTRI_AX_FIXTURE_READY\n".utf8)

    var isReady: Bool {
        lock.lock()
        defer { lock.unlock() }
        return data.range(of: marker) != nil
    }

    func append(_ chunk: Data) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard data.count < 1024 else { return data.range(of: marker) != nil }
        data.append(chunk.prefix(1024 - data.count))
        return data.range(of: marker) != nil
    }
}
