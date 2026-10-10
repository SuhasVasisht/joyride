import AppKit
import WebKit
import UserNotifications
import CoreGraphics

// Enabled only for a sandbox launch; this runner never synthesizes desktop input.
@MainActor
final class BackgroundTests {
    let app: AppDelegate
    var checks: [String] = []
    var screenshots: [[String: String]] = []
    var frontmostPIDs = Set<Int32>()
    var frontmostChanges: [[String: Any]] = []
    var timer: Timer?
    init(app: AppDelegate) { self.app = app }

    func require(_ value: Bool, _ message: String) throws {
        guard value else { throw NSError(domain: "Joyride background tests", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }
        checks.append(message)
        print("PASS \(message)")
    }
    func js(_ source: String) async throws -> Any {
        let value = try await app.web.callAsyncJavaScript("return JSON.stringify(await (async () => { \(source) })())", arguments: [:], in: nil, contentWorld: .page)
        guard let string = value as? String, let data = string.data(using: .utf8) else { return NSNull() }
        return try JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
    }
    func wait(_ predicate: String) async throws {
        _ = try await js("return await T.wait(() => \(predicate));")
    }
    func screenshot(_ name: String) async throws {
        try await Task.sleep(nanoseconds: 350_000_000)
        let file = app.config.repository.appendingPathComponent("docs/checkpoints/mac/background-\(name).png")
        var method = "WKWebView.takeSnapshot"
        // Captures this window alone, including native chrome, without focusing it.
        if CGPreflightScreenCaptureAccess() {
            let p = Process(); p.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
            p.arguments = ["-x", "-o", "-l", String(app.window.windowNumber), file.path]
            try p.run(); p.waitUntilExit()
            if p.terminationStatus == 0 { method = "screencapture-window" }
        }
        if method == "WKWebView.takeSnapshot" {
            let image: NSImage = try await withCheckedThrowingContinuation { continuation in
                app.web.takeSnapshot(with: nil) { image, error in
                    if let image { continuation.resume(returning: image) }
                    else { continuation.resume(throwing: error ?? NSError(domain: "snapshot", code: 1)) }
                }
            }
            guard let tiff = image.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff), let png = rep.representation(using: .png, properties: [:]) else { throw NSError(domain: "snapshot", code: 2) }
            try png.write(to: file)
        }
        screenshots.append(["file": file.lastPathComponent, "method": method])
    }
    func route(_ route: String) async throws {
        app.application(NSApp, open: [URL(string: "joyride://" + route)!])
        try await wait("location.hash === \(javascriptValue("#/" + route))")
        try await Task.sleep(nanoseconds: 300_000_000)
    }
    func run() async {
        let phase = ProcessInfo.processInfo.environment["JOYRIDE_MAC_TEST_PHASE"] ?? "journeys"
        var failure: String?
        frontmostPIDs.insert(app.initialFrontmost)
        timer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, let front = NSWorkspace.shared.frontmostApplication else { return }
                if self.frontmostPIDs.insert(front.processIdentifier).inserted {
                    self.frontmostChanges.append(["pid": front.processIdentifier, "bundle": front.bundleIdentifier ?? "", "time": Date().timeIntervalSince1970])
                }
            }
        }
        do {
            try require(app.testError == nil, "Sandbox connected without a native error")
            for _ in 0..<200 where !app.loaded { try await Task.sleep(nanoseconds: 100_000_000) }
            try require(app.loaded, "WKWebView loaded the shared UI")
            let helpers = try String(contentsOf: app.config.repository.appendingPathComponent("apps/mac/Tests/Background/helpers.js"), encoding: .utf8)
            _ = try await js(helpers + "; return true;")
            if phase == "cold-worker" {
                try await wait("document.querySelector('textarea[aria-label^=\"Reply to Idempotent sync job\"]')")
                try require(app.currentRoute == "/worker/local%3Aw2%3Ap1", "Cold joyride URL launch preserved encoded worker route")
                try await screenshot("cold-deep-link-worker")
            }
            else if phase == "relaunch" { try await relaunch() }
            else { try await journeys() }
            app.saveState()
            frontmostPIDs.insert(NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0)
            try require(!NSApp.isActive && !app.window.isKeyWindow && !frontmostPIDs.contains(ProcessInfo.processInfo.processIdentifier), "Native app never activated or became key")
            try require(frontmostPIDs == [app.initialFrontmost], "Frontmost application stayed unchanged throughout \(phase)")
        } catch { failure = error.localizedDescription; print("FAIL \(failure!)") }
        timer?.invalidate()
        let report: [String: Any] = ["phase": phase, "passed": failure == nil, "failure": failure ?? NSNull(), "checks": checks, "screenshots": screenshots, "initialFrontmostPID": app.initialFrontmost, "sampledFrontmostPIDs": frontmostPIDs.sorted(), "frontmostChanges": frontmostChanges, "appPID": ProcessInfo.processInfo.processIdentifier, "appBecameActive": NSApp.isActive, "windowBecameKey": app.window.isKeyWindow, "input": "WKWebView DOM events and native method calls; no desktop input", "notificationDelivery": "in-process request sink; no OS banner or permission prompt"]
        let file = app.config.repository.appendingPathComponent("docs/checkpoints/mac/background-\(phase)-report.json")
        if let data = try? JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]) { try? data.write(to: file, options: .atomic) }
        app.saveState()
        app.window.orderOut(nil)
        exit(failure == nil ? 0 : 1)
    }
    func reportBack() async throws {
        try await route("knowledge/artifacts?source=report&q=Native%20navigation")
        try await wait("[...document.querySelectorAll('[data-testid=artifact-row] button')].some(el => el.textContent.includes('Native navigation report'))")
        _ = try await js("const row=[...document.querySelectorAll('[data-testid=artifact-row] button')].find(el => el.textContent.includes('Native navigation report')); row.scrollIntoView({block:'center'}); row.click(); return true;")
        try await wait("document.querySelector('[data-testid=artifact-preview]')")
        let returnHash = try await js("return location.hash;") as? String
        let scroll = try await js("return document.querySelector('.main').scrollTop;") as? Double
        try require((scroll ?? 0) > 100, "Native report opened from a scrolled and filtered artifact list")
        _ = try await js("document.querySelector('.pane-sheet').scrollTop=120; T.click('Expand report'); return true;")
        try await wait("document.querySelector('[data-testid=artifact-expanded]')")
        try require(app.web.url?.path == "/", "Expanding a report keeps the Mac app in the React shell")
        try require(try await js("return !!document.querySelector('[data-testid=artifact-expanded] button') && location.hash.includes('expand=');") as? Bool == true, "Expanded native report has a visible back control and a history entry")
        try await screenshot("report-back-expanded-after")
        _ = try await js("T.click('Back to artifact Esc'); return true;")
        try await wait("!document.querySelector('[data-testid=artifact-expanded]')")
        try require(try await js("return location.hash;") as? String == returnHash, "Visible back returns to the same native artifact route")
        guard let view = NSApp.mainMenu?.item(withTitle: "View")?.submenu,
              let back = view.item(withTitle: "Back"), let forward = view.item(withTitle: "Forward"),
              let backAction = back.action, let forwardAction = forward.action else {
            throw NSError(domain: "navigation", code: 1, userInfo: [NSLocalizedDescriptionKey: "Native Back and Forward menus are missing"])
        }
        try require(back.keyEquivalent == "[" && forward.keyEquivalent == "]" && back.keyEquivalentModifierMask == .command && forward.keyEquivalentModifierMask == .command, "Native Back and Forward menus have Cmd-[ and Cmd-] shortcuts")
        try require(app.validateMenuItem(forward), "Forward is enabled after closing the expanded report")
        NSApp.sendAction(forwardAction, to: forward.target, from: forward)
        try await wait("document.querySelector('[data-testid=artifact-expanded]')")
        try require(app.validateMenuItem(back), "Back is enabled from the expanded report")
        NSApp.sendAction(backAction, to: back.target, from: back)
        try await wait("!document.querySelector('[data-testid=artifact-expanded]')")
        try require(try await js("return location.hash;") as? String == returnHash, "Native menu history restores the exact artifact route")
        _ = try await js("T.click('Expand report'); return true;")
        try await wait("document.querySelector('[data-testid=artifact-expanded]')")
        app.web.cancelOperation(nil)
        try await wait("!document.querySelector('[data-testid=artifact-expanded]')")
        try require(try await js("return document.querySelector('.main').scrollTop;") as? Double == scroll, "Native back and Escape preserve artifact list scroll")
        try require(try await js("return document.querySelector('.pane-sheet').scrollTop === 120;") as? Bool == true, "Native back preserves inline artifact scroll")
        try require(try await js("const rect=document.querySelector('[aria-label=\"Close and return\"]').getBoundingClientRect(); return rect.top >= 52 && rect.bottom <= innerHeight;") as? Bool == true, "Native inline report close control stays in the viewport after return")
        try require(app.web.allowsBackForwardNavigationGestures, "WebKit two-finger history gestures are enabled")
        try await screenshot("report-back-returned-after")
        _ = try await js("T.click('Close and return'); return true;")
        try await wait("!document.querySelector('[data-testid=artifact-detail]')")
        try require(try await js("return document.querySelector('input[aria-label=\"Search artifacts\"]').value === 'Native navigation' && document.querySelector('[data-testid=artifact-source-filter] button[aria-pressed=true]').textContent.includes('Joyride report');") as? Bool == true, "Native return preserves artifact search and source filter")
        try require(try await js("return document.querySelector('.main').scrollTop;") as? Double == scroll, "Native artifact list retains its original scroll after closing")
        try await screenshot("report-back-list-after")
    }
    func journeys() async throws {
        try await wait("document.querySelector('.conn.on') && document.querySelector('[data-region=\"lens:reporting\"]')")
        try await screenshot("launch-map")
        _ = try await js("T.key('k', {metaKey:true}); return true;")
        try await wait("document.querySelector('[role=dialog][aria-label=\"Command palette\"]')")
        try await screenshot("command-palette")
        _ = try await js("T.key('Escape'); T.click('Near'); return true;")
        try await wait("document.querySelector('.map-viewport.lvl-near')")
        try await screenshot("map-near")
        _ = try await js("T.click('Far'); T.key('0'); return true;")
        try await Task.sleep(nanoseconds: 500_000_000)
        _ = try await js("document.querySelector('[data-region=\"lens:reporting\"] .rl-focus').click(); return true;")
        try await wait("document.querySelector('.map-viewport[data-focus=\"lens:reporting\"]')")
        try await screenshot("map-focus")
        _ = try await js("T.key('Escape'); T.key('0'); return true;")
        try await Task.sleep(nanoseconds: 500_000_000)
        _ = try await js("await T.dragGroup('lens:reporting'); return true;")
        try await wait("document.querySelector('[data-testid=map-toast]')?.textContent.includes('Moved Reporting.')")
        let savedLayout = try await js("return Boolean((await (await fetch('/api/missions/map/layout')).json())['lens:reporting']);") as? Bool
        try require(savedLayout == true, "Map pointer drag persisted group placement in the sandbox")
        try await screenshot("map-drag")
        _ = try await js("T.key('n'); return true;")
        try await wait("document.querySelector('textarea[aria-label=\"New\"]')")
        _ = try await js("document.querySelector('textarea[aria-label=\"New\"]').focus(); return true;")
        let textBoard = NSPasteboard.withUniqueName(); defer { textBoard.releaseGlobally() }
        textBoard.setString("note: Native background draft", forType: .string)
        app.web.paste(from: textBoard)
        try await wait("document.querySelector('textarea[aria-label=\"New\"]').value === 'note: Native background draft'")
        _ = try await js("document.execCommand('undo'); return true;")
        try await wait("document.querySelector('textarea[aria-label=\"New\"]').value === ''")
        _ = try await js("document.execCommand('redo'); return true;")
        try await wait("document.querySelector('textarea[aria-label=\"New\"]').value === 'note: Native background draft'")
        try require(true, "Native plain-text paste preserves WebKit undo and redo")
        try await screenshot("new-box")
        _ = try await js("T.key('Escape'); return true;")
        try await route("worker/local%3Aw2%3Ap1")
        try await wait("document.querySelector('textarea[aria-label^=\"Reply to Idempotent sync job\"]')")
        _ = try await js("document.querySelector('textarea[aria-label^=\"Reply to Idempotent sync job\"]').focus(); return true;")
        let image = NSImage(size: NSSize(width: 240, height: 150))
        image.lockFocus(); NSColor.systemBlue.setFill(); NSRect(x: 0, y: 0, width: 240, height: 150).fill(); image.unlockFocus()
        let board = NSPasteboard.withUniqueName(); defer { board.releaseGlobally() }
        board.writeObjects([image]); app.web.paste(from: board)
        try await wait("document.querySelector('.wp-reply [data-attachment=ready]')")
        _ = try await js("T.fill(document.querySelector('.wp-reply textarea'), 'Background native sandbox image paste'); await T.dropImage(); return true;")
        try await wait("document.querySelectorAll('.wp-reply [data-attachment=ready]').length === 2")
        _ = try await js("document.querySelector('.wp-reply textarea').scrollIntoView({block:'center'}); return true;")
        try await screenshot("chat-image-paste-drop")
        _ = try await js("T.click('Send', '.wp-reply'); return true;")
        try await wait("/Delivered|picked up/.test(document.querySelector('.wp-reply [data-intent-status]')?.textContent || '')")
        try await screenshot("chat-image-delivered")
        try require(try await js("return document.querySelectorAll('.wp-reply .sent-images img').length === 2;") as? Bool == true, "Native TIFF paste and HTML file drop both reached the chat send path")
        for (path, selector) in [("knowledge", ".k-page"), ("knowledge/artifacts", ".k-page"), ("agents", ".agents-page"), ("board", "[data-testid=board-page]")] {
            try await route(path)
            try await wait("document.querySelector(\(javascriptValue(selector)))")
            try await screenshot(path.replacingOccurrences(of: "/", with: "-"))
        }
        try await reportBack()
        try await notification()
        // Test the real native navigation delegate without opening another app.
        _ = try await js("const a=document.createElement('a'); a.href='https://claude.ai/public/artifacts/native-fixture'; a.target='_blank'; document.body.append(a); a.click(); a.remove(); return true;")
        for _ in 0..<30 where app.testExternalURLs.isEmpty { try await Task.sleep(nanoseconds: 100_000_000) }
        try require(app.testExternalURLs.first?.host == "claude.ai", "External artifact navigation reached the native browser opener")
        _ = try await js("const a=document.createElement('a'); a.href='/native-fixture.pdf'; document.body.append(a); a.click(); a.remove(); return true;")
        for _ in 0..<30 where app.testExternalURLs.count < 2 { try await Task.sleep(nanoseconds: 100_000_000) }
        try require(app.testExternalURLs.last?.path == "/native-fixture.pdf", "PDF navigation reached the native browser opener")
        try await route("board")
        try await wait("document.querySelector('[data-testid=board-page]')")
        app.window.setFrame(NSRect(x: 120, y: 130, width: 1200, height: 800), display: false)
        app.zoomIn(nil)
        _ = try await js("localStorage.setItem('joyride.native-test', 'draft survives'); return true;")
        try await Task.sleep(nanoseconds: 300_000_000)
        try require(app.storage["joyride.native-test"] == "draft survives", "Shared localStorage reached native persistence")
        app.saveState()
        try await screenshot("quit-state")
    }
    func notification() async throws {
        let created = try await js("return await (await fetch('/api/attention', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({level:'L4',kind:'question',title:'Background notification fixture',why:'Choose an option',worker:'local:w2:p1'})})).json();")

        for _ in 0..<150 where !app.testNotifications.contains(where: { $0.content.body == "Background notification fixture" }) { try await Task.sleep(nanoseconds: 100_000_000) }
        guard let request = app.testNotifications.first(where: { $0.content.body == "Background notification fixture" }), let route = request.content.userInfo["route"] as? String else { throw NSError(domain: "notification", code: 1, userInfo: [NSLocalizedDescriptionKey: "React needs-you did not produce the native notification request"]) }
        let count = try await js("return (await (await fetch('/api/asks')).json()).counts.needs_you;") as? Int
        try require(NSApp.dockTile.badgeLabel == count.map(String.init), "Native Dock badge equals the shared needs-you count")
        try await screenshot("notification-badge")
        app.notificationOpened(route: route)
        try await wait("document.querySelector('textarea[aria-label^=\"Reply to Idempotent sync job\"]')")
        try require(route == "/worker/local%3Aw2%3Ap1", "Native notification click handler opened the encoded worker route")
        try await screenshot("notification-opened-worker")
        if let id = (created as? [String: Any])?["id"] as? String {
            _ = try await js("return await (await fetch('/api/attention/' + \(javascriptValue(id)) + '/label', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({label:'ack'})})).json();")
            for _ in 0..<150 where NSApp.dockTile.badgeLabel == count.map(String.init) { try await Task.sleep(nanoseconds: 100_000_000) }
            let remaining = try await js("return (await (await fetch('/api/asks')).json()).counts.needs_you;") as? Int
            try require(remaining != count && NSApp.dockTile.badgeLabel == remaining.map(String.init), "Acknowledging a needs-you item updated the native badge")
            try require(app.testNotifications.filter { $0.content.body == "Background notification fixture" }.count == 1, "Unchanged needs-you snapshots did not duplicate native notifications")
        }
    }
    func relaunch() async throws {
        try await wait("document.querySelector('[data-testid=board-page]')")
        try require(app.currentRoute == "/board", "Quit and relaunch restored Board route")
        try require(abs(app.web.pageZoom - 1.1) < 0.001, "Quit and relaunch restored native page zoom")
        try require(app.window.frame == NSRect(x: 120, y: 130, width: 1200, height: 800), "Quit and relaunch restored native window geometry")
        try require(try await js("return localStorage.getItem('joyride.native-test') === 'draft survives';") as? Bool == true, "Quit and relaunch restored shared localStorage")
        try await screenshot("quit-relaunch-board")
    }
}
