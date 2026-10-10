import Foundation
func expect(_ value: Bool, _ message: String) { if !value { fputs("FAIL \(message)\n", stderr); exit(1) } }
for value in ["https://example.com", "http://127.0.0.1:3000", "http://user@127.0.0.1:4317", "http://127.0.0.1:4317/path", "http://127.0.0.1:4317?x=1"] {
    do { _ = try Configuration(environment: ["JOYRIDE_MAC_URL": value], repositoryPath: "/repo"); expect(false, "Accepted invalid daemon URL \(value)") } catch {}
}
let c = try Configuration(environment: ["JOYRIDE_MAC_URL": "http://127.0.0.1:4328"], repositoryPath: "/repo")
expect(!c.autoStart, "Tests must not start the daemon")
expect(c.internalURL(URL(string: "http://127.0.0.1:4328/#/map")!), "Local origin should stay in app")
expect(!c.internalURL(URL(string: "http://127.0.0.1:4317")!), "Other ports are not the app origin")
expect(!c.internalURL(URL(string: "https://claude.ai/artifacts/example")!), "External artifacts should leave the app")
expect(c.route(URL(string: "joyride://map?focus=lens%3Areporting&idea=csv-export")!) == "/map?focus=lens%3Areporting&idea=csv-export", "Deep link preserves query encoding")
expect(c.route(URL(string: "joyride://worker/local%3Aw2%3Ap1")!) == "/worker/local%3Aw2%3Ap1", "Deep link preserves worker encoding")
expect(c.route(URL(string: "https://map")!) == nil, "Reject non-Joyride scheme")
expect(c.route(URL(string: "joyride://unknown/foo")!) == nil, "Reject unknown routes")
expect(javascriptValue("a'\n\"b") == "\"a'\\n\\\"b\"", "JavaScript bridge safely encodes strings")
let original = WindowState(frame: "{{1, 2}, {1440, 900}}", route: "/board", zoom: 1.2, storage: ["joyride.theme": "dark", "draft": "hello"])
let restored = try JSONDecoder().decode(WindowState.self, from: JSONEncoder().encode(original))
expect(restored.frame == original.frame && restored.route == "/board" && restored.zoom == 1.2 && restored.storage == original.storage, "Window and React storage survive relaunch")
for env: [String: String] in [
    ["JOYRIDE_MAC_BACKGROUND_TEST": "1", "JOYRIDE_MAC_NO_START": "1"],
    ["JOYRIDE_MAC_BACKGROUND_TEST": "1", "JOYRIDE_MAC_URL": "http://127.0.0.1:4407"],
    ["JOYRIDE_MAC_BACKGROUND_TEST": "1", "JOYRIDE_MAC_URL": "http://127.0.0.1:4407", "JOYRIDE_MAC_NO_START": "1", "JOYRIDE_MAC_STATE": "/outside/state"],
    ["JOYRIDE_MAC_BACKGROUND_TEST": "1", "JOYRIDE_MAC_URL": "http://127.0.0.1:4407", "JOYRIDE_MAC_NO_START": "1", "JOYRIDE_MAC_STATE": "/repo/.joyride/../../outside"],
] {
    do { _ = try Configuration(environment: env, repositoryPath: "/repo"); expect(false, "Accepted unsafe background configuration") } catch {}
}
_ = try Configuration(environment: ["JOYRIDE_MAC_BACKGROUND_TEST": "1", "JOYRIDE_MAC_URL": "http://127.0.0.1:4407", "JOYRIDE_MAC_NO_START": "1"], repositoryPath: "/repo")
print("PASS native configuration, deep links, serialization and background isolation assertions")
