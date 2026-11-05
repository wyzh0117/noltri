import Foundation
import XCTest
@testable import NoltriAXP0Spike

final class OwnedFixtureLifecycleTests: XCTestCase {
    func testReadinessTimeoutSkipsAXAndOwnedChildCleanupIsBounded() throws {
        let pipe = Pipe()
        let child = try startShell("trap '' TERM; exec /bin/sleep 30", standardOutput: pipe)
        try? pipe.fileHandleForWriting.close()

        let startedAt = Date()
        let ready = OwnedFixtureReadySignal.wait(from: pipe.fileHandleForReading, timeout: 0.05)
        var axReadCalls = 0
        let snapshot = AXOwnedFixtureReadGate.readIfReady(
            processID: child.processIdentifier,
            childIsRunning: child.isRunning,
            readySignalReceived: ready
        ) { _ in
            axReadCalls += 1
            return "should never be read"
        }

        XCTAssertFalse(ready)
        XCTAssertNil(snapshot)
        XCTAssertEqual(axReadCalls, 0)

        let cleanup = OwnedFixtureProcessCleanup.terminate(
            child,
            outputReader: pipe.fileHandleForReading,
            gracePeriod: 0.05,
            forcePeriod: 0.6
        )
        XCTAssertTrue(cleanup.exited)
        XCTAssertTrue(cleanup.didForceTerminate)
        XCTAssertLessThan(Date().timeIntervalSince(startedAt), 2.0)
    }

    func testNormalExitAndEarlyReturnBothCloseOwnedFixture() throws {
        let normalPipe = Pipe()
        let normalChild = Process()
        normalChild.executableURL = URL(fileURLWithPath: "/bin/sh")
        normalChild.arguments = ["-c", "exit 0"]
        normalChild.standardOutput = normalPipe
        let normalExitSignal = DispatchSemaphore(value: 0)
        normalChild.terminationHandler = { _ in normalExitSignal.signal() }
        try normalChild.run()
        try? normalPipe.fileHandleForWriting.close()
        XCTAssertEqual(normalExitSignal.wait(timeout: .now() + 2), .success)

        let normalCleanup = OwnedFixtureProcessCleanup.terminate(
            normalChild,
            outputReader: normalPipe.fileHandleForReading,
            gracePeriod: 0.05,
            forcePeriod: 0.1
        )
        XCTAssertTrue(normalCleanup.exited)
        XCTAssertFalse(normalCleanup.didForceTerminate)

        let earlyPipe = Pipe()
        let earlyChild = try startShell("exec /bin/sleep 30", standardOutput: earlyPipe)
        try? earlyPipe.fileHandleForWriting.close()
        var earlyCleanup: OwnedFixtureProcessCleanup.Result?

        func simulateReadinessEarlyReturn() {
            defer {
                earlyCleanup = OwnedFixtureProcessCleanup.terminate(
                    earlyChild,
                    outputReader: earlyPipe.fileHandleForReading,
                    gracePeriod: 0.5,
                    forcePeriod: 0.5
                )
            }
            return
        }

        simulateReadinessEarlyReturn()
        XCTAssertEqual(earlyCleanup?.exited, true)
    }

    func testSIGTERMIgnoringChildEscalationLeavesUnrelatedProcessRunning() throws {
        let targetPipe = Pipe()
        let target = try startShell("trap '' TERM; printf 'NOLTRI_AX_FIXTURE_READY\\n'; exec /bin/sleep 30", standardOutput: targetPipe)
        let unrelated = try startShell("exec /bin/sleep 30", standardOutput: FileHandle.nullDevice)
        try? targetPipe.fileHandleForWriting.close()
        defer {
            _ = OwnedFixtureProcessCleanup.terminate(
                target,
                outputReader: targetPipe.fileHandleForReading,
                gracePeriod: 0.05,
                forcePeriod: 0.5
            )
            _ = OwnedFixtureProcessCleanup.terminate(unrelated, outputReader: nil, gracePeriod: 0.2, forcePeriod: 0.5)
        }
        XCTAssertTrue(OwnedFixtureReadySignal.wait(from: targetPipe.fileHandleForReading, timeout: 1))

        let startedAt = Date()
        let cleanup = OwnedFixtureProcessCleanup.terminate(
            target,
            outputReader: targetPipe.fileHandleForReading,
            gracePeriod: 0.05,
            forcePeriod: 0.6
        )

        XCTAssertTrue(cleanup.exited)
        XCTAssertTrue(cleanup.didForceTerminate)
        XCTAssertTrue(unrelated.isRunning)
        XCTAssertLessThan(Date().timeIntervalSince(startedAt), 2.0)
    }

    private func startShell(_ command: String, standardOutput: Any) throws -> Process {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/sh")
        process.arguments = ["-c", command]
        process.standardOutput = standardOutput
        process.standardError = FileHandle.nullDevice
        try process.run()
        return process
    }
}
