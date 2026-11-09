import Foundation

public enum AXSupportedApplications {
    public static let bundleIdentifiers: Set<String> = [
        "com.apple.TextEdit",
        "com.apple.Notes",
    ]

    public static func contains(_ bundleIdentifier: String?) -> Bool {
        guard let bundleIdentifier else { return false }
        return bundleIdentifiers.contains(bundleIdentifier)
    }
}
