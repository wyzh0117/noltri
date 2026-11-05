import CryptoKit
import Foundation
import XCTest

final class ProbeHandoffTests: XCTestCase {
    func testMissingOrMismatchedPairMemberLaunchesNeitherExecutable() throws {
        let scenarios: [PairFailure] = [
            .missingProbe,
            .missingFixture,
            .mismatchedProbe,
            .mismatchedFixture,
        ]

        for scenario in scenarios {
            let directory = try makeTemporaryDirectory()
            defer { try? FileManager.default.removeItem(at: directory) }

            let launchLog = directory.appendingPathComponent("launches.log")
            let fixtureURL = directory.appendingPathComponent("noltri-ax-p0-fixture")
            let probeURL = directory.appendingPathComponent("noltri-ax-p0-probe")
            try writeExecutable(fixtureURL, body: "#!/bin/bash\nprintf 'approved-fixture\\n' >> \(shellLiteral(launchLog.path))\n")
            try writeExecutable(probeURL, body: "#!/bin/bash\nprintf 'approved-probe\\n' >> \(shellLiteral(launchLog.path))\nexec \(shellLiteral(fixtureURL.path))\n")

            let expectedProbeSHA = try sha256(of: probeURL)
            let expectedFixtureSHA = try sha256(of: fixtureURL)
            let handoffURL = try makeHandoffScript(
                directory: directory,
                probeURL: probeURL,
                probeSHA: expectedProbeSHA,
                fixtureURL: fixtureURL,
                fixtureSHA: expectedFixtureSHA
            )

            switch scenario {
            case .missingProbe:
                try FileManager.default.removeItem(at: probeURL)
            case .missingFixture:
                try FileManager.default.removeItem(at: fixtureURL)
            case .mismatchedProbe:
                try writeExecutable(probeURL, body: "#!/bin/bash\nprintf 'replaced-probe-ran\\n' >> \(shellLiteral(launchLog.path))\n")
            case .mismatchedFixture:
                try writeExecutable(fixtureURL, body: "#!/bin/bash\nprintf 'replaced-fixture-ran\\n' >> \(shellLiteral(launchLog.path))\n")
            }

            let status = try runScript(handoffURL)
            let log = (try? String(contentsOf: launchLog, encoding: .utf8)) ?? ""
            XCTAssertNotEqual(status, 0, "scenario: \(scenario)")
            XCTAssertEqual(log, "", "scenario: \(scenario)")
        }
    }

    func testValidPairLaunchesOnlyThePinnedProbeAndItsFixture() throws {
        let directory = try makeTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }

        let launchLog = directory.appendingPathComponent("launches.log")
        let fixtureURL = directory.appendingPathComponent("noltri-ax-p0-fixture")
        let probeURL = directory.appendingPathComponent("noltri-ax-p0-probe")
        let decoyProbeURL = directory.appendingPathComponent("unapproved-probe")
        let decoyFixtureURL = directory.appendingPathComponent("unapproved-fixture")

        try writeExecutable(fixtureURL, body: "#!/bin/bash\nprintf 'approved-fixture:%s\\n' \"$0\" >> \(shellLiteral(launchLog.path))\n")
        try writeExecutable(probeURL, body: "#!/bin/bash\nprintf 'approved-probe:%s\\n' \"$0\" >> \(shellLiteral(launchLog.path))\nexec \(shellLiteral(fixtureURL.path))\n")
        try writeExecutable(decoyProbeURL, body: "#!/bin/bash\nprintf 'decoy-probe\\n' >> \(shellLiteral(launchLog.path))\n")
        try writeExecutable(decoyFixtureURL, body: "#!/bin/bash\nprintf 'decoy-fixture\\n' >> \(shellLiteral(launchLog.path))\n")

        let handoffURL = try makeHandoffScript(
            directory: directory,
            probeURL: probeURL,
            probeSHA: sha256(of: probeURL),
            fixtureURL: fixtureURL,
            fixtureSHA: sha256(of: fixtureURL)
        )

        XCTAssertEqual(try runScript(handoffURL), 0)
        let lines = try String(contentsOf: launchLog, encoding: .utf8).split(separator: "\n")
        XCTAssertEqual(lines, [
            "approved-probe:\(probeURL.path)",
            "approved-fixture:\(fixtureURL.path)",
        ])
    }

    private enum PairFailure: CustomStringConvertible {
        case missingProbe
        case missingFixture
        case mismatchedProbe
        case mismatchedFixture

        var description: String {
            switch self {
            case .missingProbe: "missing probe"
            case .missingFixture: "missing fixture"
            case .mismatchedProbe: "mismatched probe"
            case .mismatchedFixture: "mismatched fixture"
            }
        }
    }

    private func makeTemporaryDirectory() throws -> URL {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("noltri-ax-handoff-test-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
        return directory
    }

    private func makeHandoffScript(
        directory: URL,
        probeURL: URL,
        probeSHA: String,
        fixtureURL: URL,
        fixtureSHA: String
    ) throws -> URL {
        let testsDirectory = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        let packageRoot = testsDirectory.deletingLastPathComponent().deletingLastPathComponent()
        let templateURL = packageRoot.appendingPathComponent("Scripts/run-approved-synthetic-probe.sh.template")
        var text = try String(contentsOf: templateURL, encoding: .utf8)

        let replacements = [
            "__NOLTRI_PROBE_PATH__": shellLiteral(probeURL.path),
            "__NOLTRI_PROBE_SHA256__": probeSHA,
            "__NOLTRI_FIXTURE_PATH__": shellLiteral(fixtureURL.path),
            "__NOLTRI_FIXTURE_SHA256__": fixtureSHA,
        ]
        for (token, value) in replacements {
            XCTAssertTrue(text.contains(token), "template missing \(token)")
            text = text.replacingOccurrences(of: token, with: value)
        }

        let scriptURL = directory.appendingPathComponent("run-approved-synthetic-probe.sh")
        try writeExecutable(scriptURL, body: text)
        return scriptURL
    }

    private func writeExecutable(_ url: URL, body: String) throws {
        try body.write(to: url, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: url.path)
    }

    private func runScript(_ url: URL) throws -> Int32 {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/bash")
        process.arguments = [url.path]
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        try process.run()
        process.waitUntilExit()
        return process.terminationStatus
    }

    private func sha256(of url: URL) throws -> String {
        let digest = SHA256.hash(data: try Data(contentsOf: url))
        return digest.map { String(format: "%02x", $0) }.joined()
    }

    private func shellLiteral(_ value: String) -> String {
        "'" + value.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }
}
