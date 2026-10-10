# Joyride for macOS

The macOS app is an AppKit window containing a WKWebView. It loads the same React bundle in `src/ui` from the same Joyride daemon as the browser. All screens, API calls, map behavior, chat and attachment uploads remain in React. The browser continues to work. Swift owns the window, menus, clipboard conversion, URL handling, Dock badge and OS notifications.

## Build and run

Requires macOS 13 or newer, Apple Command Line Tools with Swift 6, and the existing Node dependencies. Xcode is optional. In this checkout:

```sh
npm ci
npm run build
apps/mac/build.sh
open dist/mac/Joyride.app
```

The build uses Swift Package Manager and creates an unsigned `dist/mac/Joyride.app` with an Info.plist, executable and generated icon. It embeds this checkout's path; rebuild after moving the checkout. The app needs the checkout and its Node dependencies beside it. This is a development app, not a standalone distribution.

The app connects to `http://127.0.0.1:4317`. If Joyride is missing, it starts the existing detached Joyride supervisor through `joyride up` from the embedded checkout, waits up to 30 seconds, and shows a native error with a log path if startup fails. It does not stop or restart an existing daemon. The daemon it starts remains running when the window quits. The shell sets `JOYRIDE_MANAGE_HERDR=0` on that launch; it never administers Herdr.

For a daemon already running on another loopback port, launch the executable with an override:

```sh
JOYRIDE_MAC_URL=http://127.0.0.1:4407 JOYRIDE_MAC_NO_START=1 \
  dist/mac/Joyride.app/Contents/MacOS/JoyrideMac
```

`JOYRIDE_MAC_REPO` overrides the embedded checkout. `JOYRIDE_MAC_STATE` overrides the state directory, normally `.joyride/mac` within the checkout. Window geometry, current route, page zoom and React localStorage, including chat drafts, live in `window.json` there. WebKit uses an ephemeral website store, so it does not share the browser's cookies or preferences. The shared backend supplies the same workspace data to both clients.

## Native behavior

- Standard window title bar and traffic lights; size and position survive quit and reopen.
- App, Edit, View, Window and Help menus. Edit uses the web content's responder chain for copy, cut, select all, undo and redo. Paste converts macOS screenshot TIFF data to PNG and sends it through React's existing attachment path. Plain text paste uses the web editor's undo history.
- Cmd-K, N and the React shortcuts reach the page. View provides Back with Cmd-[, Forward with Cmd-], reload and page zoom. WebKit's two-finger back/forward gestures are enabled. The map's own semantic zoom remains in React.
- Expand report opens a full-window preview inside React with a visible Back to artifact control and Escape. Closing or navigating back retains the artifact list's filters and scroll, plus the inline report's scroll. Browser history also supports expansion and return.
- File drops use WKWebView's HTML file drag support and the existing React drop zones. Pasting copied image files and screenshots uses the native bridge. Focus the chat composer before pasting an image.
- External HTTP links, including Claude artifacts, and PDF URLs open in the default browser. Navigation is restricted to the configured daemon origin; native messages are accepted only from its main frame. Other URL schemes do not execute through web navigation.
- The Dock badge counts the actionable needs-you projection. New L3/L4 items post macOS notifications. Clicking a notification opens its task, worker, session or idea and shows the needs-you rail. Allow notifications when macOS asks; notification delivery remains subject to the system's notification settings and Focus mode.
- `joyride://map?focus=lens%3Areporting&idea=csv-export`, `joyride://worker/local%3Aw2%3Ap1`, `joyride://board` and other known routes open in the app. Encoded route identifiers and queries are preserved.

The bridge in `src/ui/lib/native.ts` is feature detected. Normal browsers do not send native messages. Swift injects the host bridge at document start; it contains no screen markup or frontend routing implementation.

## Verification

Record checks from the repository root:

```sh
bin/joyride-evidence run --name 'mac build' --mission build-joyride -- apps/mac/build.sh
bin/joyride-evidence run --name 'mac unit tests' --mission build-joyride -- apps/mac/test-swift.sh
JOYRIDE_FIRSTMATE_DIR="$PWD/vendor/firstmate" \
  bin/joyride-evidence run --name 'unit tests' --mission build-joyride -- npx vitest run tests/unit
bin/joyride-evidence run --name typecheck --mission build-joyride -- npm run typecheck
bin/joyride-evidence run --name build --mission build-joyride -- npm run build
JOYRIDE_FIRSTMATE_DIR="$PWD/vendor/firstmate" \
  bin/joyride-evidence run --name 'mac shared UI e2e' --mission build-joyride -- \
  scripts/e2e.sh 4408 tests/e2e/native-bridge.spec.ts tests/e2e/shell.spec.ts tests/e2e/images.spec.ts
JOYRIDE_FIRSTMATE_DIR="$PWD/vendor/firstmate" \
  bin/joyride-evidence run --name 'mac native e2e' --mission build-joyride -- \
  node_modules/.bin/tsx apps/mac/Tests/Background/run.ts
```

The Swift assertion runner works with Command Line Tools alone; XCTest is not present in that SDK. Native e2e starts a fresh sandbox with fake stores and fake agents on port 4407, seeds the map, launches the built app with daemon auto-start disabled, and shuts down only that sandbox. Set `E2E_PORT` to an unused spare port if needed. It never sends a reply to a real session or touches the live daemon on 4317.

The default native journeys run entirely in the background. The app uses an accessory activation policy, orders its window below other windows, and never activates or becomes key. The test runner uses DOM events inside its own WKWebView and direct native method calls; it never sends OS keyboard or mouse input, changes the system clipboard, requests notification permission, or opens another application. It samples the frontmost application every 100 ms and asserts that it stays unchanged, recording the samples in `docs/checkpoints/mac/background-*-report.json`.

Screenshots capture the unfocused app window with `screencapture -l <windowID> -o` when Screen Recording is already authorized. Otherwise WebKit's native `takeSnapshot` captures the rendered web content without asking for permission. Each report names the capture method. The latter proves rendering in WKWebView but does not capture title-bar chrome. Files live in `docs/checkpoints/mac/background-*.png`.

The journeys cover launch, the shared Cmd-K handler, map zoom/focus/pointer drag with persisted placement, New with native text paste and WebKit undo/redo, a sandbox session with native TIFF paste and HTML image drop/send, Search/Artifacts, Agents, Board, warm and cold encoded deep links, native notification requests/click routing and Dock badge updates after acknowledgment, external/PDF navigation, and quit/relaunch geometry, zoom, route and localStorage. Notifications and external navigation use an in-process sink in test mode so they cannot interrupt desktop work. This verifies request generation and the app's response handler; OS banner delivery/clicking and physical mouse/keyboard behavior remain manual checks. The existing Playwright tests supply functional coverage for the same React frontend. `shared-ui-native-bridge.png` is browser evidence, not a native screenshot.

Test mode requires a spare loopback port, disabled daemon startup, and state under this checkout's `.joyride` directory. It refuses the live port 4317. The coordinator times out and terminates only its own app and sandbox. The removed XCUITest and AX input runners cannot be invoked through any default command; desktop input automation is not part of this project.

## Optional Xcode build

The Xcode project and shared `JoyrideMac` scheme compile the same Swift source files as SwiftPM. There is no UI automation test target. Building does not launch the app:

```sh
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
  bin/joyride-evidence run --name 'mac Xcode build' --mission build-joyride -- \
  apps/mac/build-xcode.sh build
```

Derived data lives under `.joyride/mac-xcode`. The built app is `.joyride/mac-xcode/Build/Products/Debug/JoyrideMac.app`. The build script sets `DEVELOPER_DIR` locally and uses ad hoc signing; it never changes `xcode-select` or accepts a license. Notarization and App Store packaging remain outside v1.
