import Foundation

struct Configuration {
    let origin: URL
    let repository: URL
    let state: URL
    let autoStart: Bool

    init(environment: [String: String] = ProcessInfo.processInfo.environment, repositoryPath: String) throws {
        guard let url = URL(string: environment["JOYRIDE_MAC_URL"] ?? "http://127.0.0.1:4317"),
              url.scheme == "http", url.host == "127.0.0.1", url.user == nil, url.password == nil,
              url.path.isEmpty || url.path == "/", url.query == nil, url.fragment == nil,
              let port = url.port, (1024...65535).contains(port), port != 3000 else {
            throw NSError(domain: "Joyride", code: 1, userInfo: [NSLocalizedDescriptionKey: "Use a loopback daemon URL such as http://127.0.0.1:4317 in JOYRIDE_MAC_URL."])
        }
        origin = url
        repository = URL(fileURLWithPath: repositoryPath, isDirectory: true)
        state = URL(fileURLWithPath: environment["JOYRIDE_MAC_STATE"] ?? repositoryPath + "/.joyride/mac", isDirectory: true)
        autoStart = environment["JOYRIDE_MAC_NO_START"] != "1" && port == 4317
        if environment["JOYRIDE_MAC_BACKGROUND_TEST"] == "1" {
            guard port != 4317, environment["JOYRIDE_MAC_NO_START"] == "1",
                  state.resolvingSymlinksInPath().standardizedFileURL.path.hasPrefix(repository.resolvingSymlinksInPath().standardizedFileURL.path + "/.joyride/") else {
                throw NSError(domain: "Joyride", code: 4, userInfo: [NSLocalizedDescriptionKey: "Background tests require a sandbox port, disabled daemon startup, and state inside this checkout’s .joyride directory."])
            }
        }
    }

    func internalURL(_ url: URL) -> Bool {
        url.scheme == origin.scheme && url.host == origin.host && url.port == origin.port
    }

    func route(_ deepLink: URL) -> String? {
        guard deepLink.scheme == "joyride", deepLink.user == nil, deepLink.password == nil,
              let host = deepLink.host, !host.isEmpty,
              ["map", "agents", "board", "knowledge", "worker", "session", "mission", "task", "settings"].contains(host),
              let parts = URLComponents(url: deepLink, resolvingAgainstBaseURL: false) else { return nil }
        return "/" + host + parts.percentEncodedPath + (parts.percentEncodedQuery.map { "?" + $0 } ?? "")
    }
}

struct WindowState: Codable {
    var frame: String
    var route: String
    var zoom: Double
    var storage: [String: String] = [:]
}

func javascriptValue(_ value: Any) -> String {
    guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed]),
          let text = String(data: data, encoding: .utf8) else { return "null" }
    return text
}
