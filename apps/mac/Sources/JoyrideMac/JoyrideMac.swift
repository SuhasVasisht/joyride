import AppKit
import WebKit
import UserNotifications

@MainActor
final class JoyrideWebView: WKWebView {
    func deliver(_ data: Data, name: String, type: String) {
        guard data.count <= 10 * 1024 * 1024 else { NSSound.beep(); return }
        evaluateJavaScript("window.joyrideNative?.receiveImage(\(javascriptValue(["data": data.base64EncodedString(), "name": name, "type": type])))")
    }

    @objc func pasteImageOrText(_ sender: Any?) { paste(from: .general) }

    override func cancelOperation(_ sender: Any?) {
        evaluateJavaScript("document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true, cancelable:true}))")
    }

    func paste(from board: NSPasteboard) {
        if let urls = board.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL], !urls.isEmpty {
            for url in urls {
                let types = ["png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "gif": "image/gif", "webp": "image/webp"]
                if let type = types[url.pathExtension.lowercased()], let attrs = try? FileManager.default.attributesOfItem(atPath: url.path), let size = attrs[.size] as? NSNumber, size.intValue <= 10 * 1024 * 1024, let data = try? Data(contentsOf: url) { deliver(data, name: url.lastPathComponent, type: type) }
            }
            return
        }
        if let png = board.data(forType: .png) { deliver(png, name: "clipboard.png", type: "image/png"); return }
        if let tiff = board.data(forType: .tiff), let image = NSBitmapImageRep(data: tiff), let png = image.representation(using: .png, properties: [:]) {
            deliver(png, name: "clipboard.png", type: "image/png"); return
        }
        if let text = board.string(forType: .string) {
            evaluateJavaScript("document.execCommand('insertText', false, \(javascriptValue(text)))")
        }
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler, UNUserNotificationCenterDelegate, NSWindowDelegate, NSMenuItemValidation {
    var window: NSWindow!
    var web: JoyrideWebView!
    var config: Configuration!
    var currentRoute = "/map"
    var pendingRoute: String?
    var pendingLink: URL?
    var storage: [String: String] = [:]
    var seen = Set<String>()
    var daemon: Process?
    var notificationCenter: UNUserNotificationCenter?
    var loaded = false
    let backgroundTests = ProcessInfo.processInfo.environment["JOYRIDE_MAC_BACKGROUND_TEST"] == "1"
    var testNotifications: [UNNotificationRequest] = []
    var testExternalURLs: [URL] = []
    var testError: String?
    var backgroundRunner: BackgroundTests?
    var initialFrontmost: Int32 = 0

    func applicationDidFinishLaunching(_ notification: Notification) {
        do {
            let path: String
            if let override = ProcessInfo.processInfo.environment["JOYRIDE_MAC_REPO"] { path = override }
            else if let resource = Bundle.main.url(forResource: "repository", withExtension: "txt") { path = try String(contentsOf: resource, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines) }
            else { throw NSError(domain: "Joyride", code: 3, userInfo: [NSLocalizedDescriptionKey: "Set JOYRIDE_MAC_REPO to the Joyride checkout when using swift run."]) }
            config = try Configuration(repositoryPath: path)
            try FileManager.default.createDirectory(at: config.state, withIntermediateDirectories: true)
        } catch { fail(error.localizedDescription); return }
        let saved = (try? Data(contentsOf: config.state.appendingPathComponent("window.json"))).flatMap { try? JSONDecoder().decode(WindowState.self, from: $0) }
        storage = saved?.storage ?? [:]
        if let link = pendingLink { pendingRoute = config.route(link); pendingLink = nil }
        let content = WKUserContentController()
        content.add(self, name: "joyride")
        content.addUserScript(WKUserScript(source: """
        if (location.origin === \(javascriptValue(config.origin.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/"))))) {
          window.joyrideNative = {
            postMessage: message => window.webkit.messageHandlers.joyride.postMessage(message),
            receiveImage: image => {
              const el = document.activeElement;
              if (!el || !(el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement)) return false;
              const bytes = Uint8Array.from(atob(image.data), c => c.charCodeAt(0));
              const transfer = new DataTransfer();
              transfer.items.add(new File([bytes], image.name, {type: image.type}));
              el.dispatchEvent(new ClipboardEvent('paste', {clipboardData: transfer, bubbles: true, cancelable: true}));
              return true;
            }
          };
          for (const [key, value] of Object.entries(\(javascriptValue(storage)))) localStorage.setItem(key, value);
          let saveTimer;
          const saveStorage = () => {
            clearTimeout(saveTimer);
            saveTimer = setTimeout(() => window.webkit.messageHandlers.joyride.postMessage({kind:'storage', values:Object.fromEntries(Object.keys(localStorage).map(key => [key, localStorage.getItem(key)]))}), 100);
          };
          for (const name of ['setItem', 'removeItem', 'clear']) {
            const original = Storage.prototype[name];
            Storage.prototype[name] = function(...args) { const value = original.apply(this, args); if (this === localStorage) saveStorage(); return value; };
          }
          addEventListener('hashchange', () => window.joyrideNative.postMessage({kind:'route', route:location.hash.slice(1)}));
        }
        """, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        let wc = WKWebViewConfiguration()
        wc.userContentController = content
        // No persistent browser store outside the workspace. UI state is restored from our state file.
        wc.websiteDataStore = .nonPersistent()
        web = JoyrideWebView(frame: .zero, configuration: wc)
        web.navigationDelegate = self
        web.uiDelegate = self
        web.allowsBackForwardNavigationGestures = true
        window = NSWindow(contentRect: NSRect(x: 100, y: 100, width: 1440, height: 900), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "Joyride"
        window.minSize = NSSize(width: 900, height: 600)
        window.contentView = web
        window.delegate = self
        if let saved {
            let rect = NSRectFromString(saved.frame)
            if NSScreen.screens.contains(where: { $0.visibleFrame.intersects(rect) }) { window.setFrame(rect, display: false) }
            currentRoute = saved.route.hasPrefix("/") ? saved.route : "/map"
            web.pageZoom = max(0.5, min(2, saved.zoom))
        }
        menus()
        if backgroundTests { window.order(.below, relativeTo: 0) }
        else { presentWindow() }
        // UNUserNotificationCenter requires an app bundle. Direct swift run remains useful for development.
        if !backgroundTests && Bundle.main.bundleIdentifier != nil {
            notificationCenter = UNUserNotificationCenter.current()
            notificationCenter?.delegate = self
            notificationCenter?.requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in }
        }
        Task {
            await connect()
            if backgroundTests {
                let runner = BackgroundTests(app: self)
                backgroundRunner = runner
                await runner.run()
            }
        }
    }

    func healthy() async -> Bool {
        do {
            var req = URLRequest(url: config.origin.appendingPathComponent("api/health"))
            req.timeoutInterval = 2
            let (data, response) = try await URLSession.shared.data(for: req)
            guard (response as? HTTPURLResponse)?.statusCode == 200,
                  let body = try JSONSerialization.jsonObject(with: data) as? [String: Any], body["ok"] as? Bool == true,
                  body["modules"] is [String] else { return false }
            return true
        } catch { return false }
    }

    func connect() async {
        if !(await healthy()) {
            guard config.autoStart else { fail("Joyride is not reachable at \(config.origin). Start the sandbox daemon, then choose View > Reload."); return }
            do {
                guard FileManager.default.fileExists(atPath: config.repository.appendingPathComponent("dist/ui/index.html").path) else {
                    throw NSError(domain: "Joyride", code: 2, userInfo: [NSLocalizedDescriptionKey: "Build the shared UI with npm run build in \(config.repository.path), then reopen Joyride."])
                }
                let process = Process()
                process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
                process.arguments = ["node", config.repository.appendingPathComponent("node_modules/tsx/dist/cli.mjs").path, config.repository.appendingPathComponent("src/cli/joyride.ts").path, "up"]
                process.currentDirectoryURL = config.repository
                var env = ProcessInfo.processInfo.environment
                env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:" + (env["PATH"] ?? "")
                // The shell starts only Joyride. Herdr lifecycle remains the daemon operator's responsibility.
                env["JOYRIDE_MANAGE_HERDR"] = "0"
                env["JOYRIDE_INTERNAL"] = "1"
                process.environment = env
                let log = config.state.appendingPathComponent("daemon.log")
                FileManager.default.createFile(atPath: log.path, contents: nil)
                let output = try FileHandle(forWritingTo: log)
                process.standardOutput = output; process.standardError = output
                try process.run(); daemon = process
                for _ in 0..<60 {
                    if await healthy() { break }
                    try await Task.sleep(nanoseconds: 500_000_000)
                }
                guard await healthy() else { fail("Joyride could not start. Read \(log.path), run npm start in \(config.repository.path), then reopen the app."); return }
            } catch { fail("Joyride could not start: \(error.localizedDescription)"); return }
        }
        openRoute(pendingRoute ?? currentRoute)
    }

    func fail(_ message: String) {
        if backgroundTests {
            testError = message
            if window == nil { fputs(message + "\n", stderr); exit(1) }
            return
        }
        let alert = NSAlert(); alert.messageText = "Joyride could not connect"; alert.informativeText = message; alert.addButton(withTitle: "OK"); alert.runModal()
    }

    func openRoute(_ route: String) {
        currentRoute = route
        if !loaded {
            var parts = URLComponents(url: config.origin, resolvingAgainstBaseURL: false)!
            parts.fragment = route
            web.load(URLRequest(url: parts.url!))
        } else { web.evaluateJavaScript("location.hash = \(javascriptValue(route))") }
        presentWindow()
    }

    func presentWindow() {
        guard !backgroundTests else { return }
        window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
    }

    func openExternal(_ url: URL) {
        if backgroundTests { testExternalURLs.append(url) }
        else { NSWorkspace.shared.open(url) }
    }

    func notificationOpened(route: String) {
        guard route.hasPrefix("/") else { return }
        openRoute(route)
        web.evaluateJavaScript("dispatchEvent(new Event('joyride:show-needs-you'))")
    }

    func application(_ application: NSApplication, open urls: [URL]) {
        for url in urls {
            // Configuration may not exist yet on a cold URL launch.
            if let config, let route = config.route(url) { if loaded { openRoute(route) } else { pendingRoute = route } }
            else if config == nil { pendingLink = url }
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        loaded = true
        if let route = pendingRoute { pendingRoute = nil; openRoute(route) }
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { fail("The page could not load: \(error.localizedDescription). Choose View > Reload to retry.") }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
        if config.internalURL(url) && url.path.lowercased().hasSuffix(".pdf") == false { decisionHandler(.allow) }
        else {
            if ["http", "https"].contains(url.scheme ?? "") { openExternal(url) }
            decisionHandler(.cancel)
        }
    }
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url {
            if config.internalURL(url) && !url.path.lowercased().hasSuffix(".pdf") { web.load(URLRequest(url: url)) }
            else if ["http", "https"].contains(url.scheme ?? "") { openExternal(url) }
        }
        return nil
    }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, let url = message.frameInfo.request.url, config.internalURL(url),
              let body = message.body as? [String: Any], let kind = body["kind"] as? String else { return }
        if kind == "storage", let values = body["values"] as? [String: String], javascriptValue(values).utf8.count <= 5 * 1024 * 1024 { storage = values; saveState() }
        if kind == "route", let route = body["route"] as? String, route.hasPrefix("/") { currentRoute = route; saveState() }
        if kind == "needs-you", let items = body["items"] as? [[String: String]], items.count <= 1000 {
            NSApp.dockTile.badgeLabel = items.isEmpty ? nil : String(items.count)
            let ids = Set(items.compactMap { $0["id"] })
            for item in items where !seen.contains(item["id"] ?? "") {
                guard let id = item["id"], let title = item["title"], let route = item["route"], route.hasPrefix("/"), ["L3", "L4"].contains(item["level"] ?? "") else { continue }
                let content = UNMutableNotificationContent(); content.title = "Joyride needs you"; content.body = String(title.prefix(500)); content.sound = .default; content.userInfo = ["route": route]
                let request = UNNotificationRequest(identifier: id, content: content, trigger: nil)
                if backgroundTests { testNotifications.append(request) }
                else { notificationCenter?.add(request) }
            }
            notificationCenter?.removeDeliveredNotifications(withIdentifiers: Array(seen.subtracting(ids)))
            seen = ids
        }
    }
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler completionHandler: @escaping () -> Void) {
        let route = response.notification.request.content.userInfo["route"] as? String
        Task { @MainActor in if let route, route.hasPrefix("/") { self.notificationOpened(route: route) }; completionHandler() }
    }
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) { completionHandler([.banner, .sound]) }
    func saveState() {
        guard config != nil, window != nil else { return }
        let state = WindowState(frame: NSStringFromRect(window.frame), route: currentRoute, zoom: web.pageZoom, storage: storage)
        if let data = try? JSONEncoder().encode(state) { try? data.write(to: config.state.appendingPathComponent("window.json"), options: .atomic) }
    }
    func windowDidResize(_ notification: Notification) { saveState() }
    func windowDidMove(_ notification: Notification) { saveState() }
    func applicationWillTerminate(_ notification: Notification) { saveState() }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
    @objc func reload(_ sender: Any?) { if loaded { web.reload() } else { Task { await connect() } } }
    @objc func zoomIn(_ sender: Any?) { web.pageZoom = min(2, web.pageZoom + 0.1); saveState() }
    @objc func zoomOut(_ sender: Any?) { web.pageZoom = max(0.5, web.pageZoom - 0.1); saveState() }
    @objc func actualSize(_ sender: Any?) { web.pageZoom = 1; saveState() }
    @objc func help(_ sender: Any?) { NSWorkspace.shared.open(config.repository.appendingPathComponent("docs/mac-app.md")) }

    func menus() {
        let bar = NSMenu()
        func menu(_ title: String) -> NSMenu { let item = NSMenuItem(); item.title = title; bar.addItem(item); let menu = NSMenu(title: title); item.submenu = menu; return menu }
        func add(_ menu: NSMenu, _ title: String, _ action: Selector?, _ key: String = "", _ target: AnyObject? = nil) { let item = NSMenuItem(title: title, action: action, keyEquivalent: key); item.target = target; menu.addItem(item) }
        let app = menu("Joyride")
        add(app, "About Joyride", #selector(NSApplication.orderFrontStandardAboutPanel(_:)), "", NSApp)
        app.addItem(.separator()); add(app, "Hide Joyride", #selector(NSApplication.hide(_:)), "h", NSApp); add(app, "Show all", #selector(NSApplication.unhideAllApplications(_:)), "", NSApp)
        app.addItem(.separator()); add(app, "Quit Joyride", #selector(NSApplication.terminate(_:)), "q", NSApp)
        let edit = menu("Edit")
        for (title, selector, key) in [("Undo", "undo:", "z"), ("Redo", "redo:", "Z"), ("Cut", "cut:", "x"), ("Copy", "copy:", "c"), ("Select all", "selectAll:", "a")] { add(edit, title, NSSelectorFromString(selector), key) }
        add(edit, "Paste", #selector(JoyrideWebView.pasteImageOrText(_:)), "v", web)
        let view = menu("View")
        add(view, "Back", #selector(goBack(_:)), "[", self); add(view, "Forward", #selector(goForward(_:)), "]", self)
        view.addItem(.separator())
        add(view, "Reload", #selector(reload(_:)), "r", self); add(view, "Zoom in", #selector(zoomIn(_:)), "+", self); add(view, "Zoom out", #selector(zoomOut(_:)), "-", self); add(view, "Actual size", #selector(actualSize(_:)), "", self)
        let windows = menu("Window"); add(windows, "Minimize", #selector(NSWindow.performMiniaturize(_:)), "m"); add(windows, "Zoom", #selector(NSWindow.performZoom(_:))); add(windows, "Bring all to front", #selector(NSApplication.arrangeInFront(_:)), "", NSApp); NSApp.windowsMenu = windows
        let helpMenu = menu("Help"); add(helpMenu, "Joyride help", #selector(help(_:)), "", self); NSApp.helpMenu = helpMenu
        NSApp.mainMenu = bar
    }

    @objc func goBack(_ sender: Any?) { if web.canGoBack { web.goBack() } }
    @objc func goForward(_ sender: Any?) { if web.canGoForward { web.goForward() } }
    func validateMenuItem(_ menuItem: NSMenuItem) -> Bool {
        if menuItem.action == #selector(goBack(_:)) { return web.canGoBack }
        if menuItem.action == #selector(goForward(_:)) { return web.canGoForward }
        return true
    }
}

@main
struct JoyrideMain {
    @MainActor static func main() {
        let initialFrontmost = NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0
        let application = NSApplication.shared
        let delegate = AppDelegate()
        delegate.initialFrontmost = initialFrontmost
        if delegate.backgroundTests, let link = ProcessInfo.processInfo.environment["JOYRIDE_MAC_TEST_LINK"] { delegate.pendingLink = URL(string: link) }
        application.setActivationPolicy(delegate.backgroundTests ? .accessory : .regular)
        application.delegate = delegate
        application.run()
    }
}
