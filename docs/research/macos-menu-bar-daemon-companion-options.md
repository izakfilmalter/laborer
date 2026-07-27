# macOS menu-bar companion options for the Laborer daemon

**Research date:** 2026-07-25

## Question

Can the primary `next/` Laborer daemon have a good React, React Native, or
TypeScript macOS menu-bar companion, or does the companion need to be a native
app?

## Answer

It does **not** have to be a native Swift app.

- Given Laborer's preference for Chromium over Tauri/WebKit and the expected
  future webview application, **Electron is the recommended product choice**.
  The first version can be a windowless main process using only Electron's
  built-in `Tray` and `Menu`; it does not need React yet. A later window,
  popover, or embedded web experience can reuse the same shell and add React.
- **Tauri 2 is the strongest lightweight React alternative**. It has first-party
  tray APIs in both JavaScript and Rust, uses the system webview, has a signed
  updater, and has documented macOS signing and notarization. A small Rust shell
  is unavoidable, but Swift/AppKit code is not.
- For only a status icon and a short native command menu, **SwiftUI
  `MenuBarExtra` is the simplest and most native solution**. In that scope,
  React is mostly unused machinery.
- **React Native macOS is active and credible for windowed native macOS UIs,
  but is not a status-item framework.** Its documented escape hatch for missing
  macOS APIs is an AppKit native module. A menu-bar-only app would therefore
  retain Xcode/native host work while adding the React Native runtime and build
  system.
- **Neutralinojs is a credible lightweight TypeScript/React prototype option**,
  but its macOS release pipeline is less complete than Tauri's: the official
  distribution guide still delegates app-bundle automation to community build
  scripts and says macOS installers are not documented. Its updater replaces
  web resources, not framework binaries.

The shell choice should remain separate from daemon ownership. Add a small,
authenticated local control/status protocol to the daemon and let a LaunchAgent
own the daemon process. The menu app should observe and request explicit
start/stop/restart operations; it should not infer daemon health from the current
lock port, scrape logs, or own Slack credentials.

## Repository constraints

This recommendation follows Laborer's existing boundaries rather than treating
the companion as a second implementation of the Runner:

- The canonical **Laborer daemon** supervises one or more root-bound Runners
  without merging their state. The Runner owns ingestion, durable ordering,
  process supervision, and delivery; Slack details remain in adapters. See
  [`CONTEXT.md`](../../CONTEXT.md) and
  [`next/AGENTS.md`](../../next/AGENTS.md).
- The current live entrypoint is a long-running Node/Effect process. It starts
  one app-wide Socket Mode receiver, waits for `SIGINT` or `SIGTERM`, and then
  closes its Effect scope. It currently exposes no operator health/control API.
  See
  [`next/src/slack/live.ts`](../../next/src/slack/live.ts).
- Runtime state and a per-root ownership lock live under
  `.laborer-runtime/`. The lock's loopback TCP server proves exclusive
  ownership; it is not an authenticated control protocol. See
  [`next/src/slack/runtime-paths.ts`](../../next/src/slack/runtime-paths.ts) and
  [`next/src/slack/runner-lock.ts`](../../next/src/slack/runner-lock.ts).
- Slack credentials are resolved from macOS Keychain into the daemon's
  environment at launch, and are kept out of tracked `.env` files and handler
  environments. The menu app should not broaden that secret boundary. See
  [`docs/slack-local-secrets.md`](../slack-local-secrets.md).
- ADR 0003 says heuristic liveness is advisory and destructive recovery requires
  an explicit event or user action. It is about the legacy terminal service,
  but the same failure asymmetry should guide the daemon companion: a missing
  heartbeat may display "unresponsive"; it should not silently kill work. See
  [`docs/adr/0003-advisory-liveness-explicit-terminal-lifecycle.md`](../adr/0003-advisory-liveness-explicit-terminal-lifecycle.md).

## Comparison

| Option | Menu-bar API | React / TypeScript fit | Daemon integration | Distribution and updates | Cost and maturity | Native Swift/AppKit required? | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **Tauri 2** | First-party `TrayIcon`, native menus, click events, and macOS `Accessory` activation policy | React works normally in a webview; tray APIs are exposed to JavaScript. Rust is still the application shell. | Can connect to a local socket, spawn an installed daemon, or bundle a per-architecture external sidecar. | Documented `.app`/DMG build, Developer ID signing, notarization, and signed updater artifacts. | Uses the OS webview; Tauri says a minimal app can be under 600 KB. Stable v2 has been available since 2024 and the core crate was at 2.11.5 in July 2026. A bundled Node daemon/runtime will dominate the final size. | **No Swift/AppKit.** Some Rust is required, especially for a windowless tray and process lifecycle. | **Best lightweight alternative, but conflicts with the stated WebKit preference.** |
| **Electron** | Mature first-party `Tray`, `Menu`, macOS template images, title, pressed image, and Dock hiding | Best all-TypeScript/Node fit. React is optional and only needed for a popover/window. | Main process can use Node IPC, Unix sockets, and child processes directly. Do not collapse the daemon and UI into one failure domain merely because they share Node. | Electron Forge is the recommended packager; official signing/notarization tooling and macOS `autoUpdater` are mature. Updates require a signed app. | Electron bundles Chromium and Node. Its own guidance says zipped apps are usually 80–100 MB. Electron 43.2.0 was current on 2026-07-21. | **No.** | **Recommended: built-in menu now, Chromium/React application later.** |
| **React Native macOS** | No documented first-party `NSStatusItem`/tray abstraction | TypeScript/React can render the popover or settings content as native views. | Native module or ordinary JS networking can speak to the daemon, but host lifecycle and the status item remain native concerns. | Xcode project/build flow. Code signing/notarization use Apple's native pipeline; an updater must be selected and integrated separately. | Active Microsoft fork: 0.81.8 shipped 2026-06-26. It brings React Native, Metro, CocoaPods/Xcode, and a native host to a UI that may only need a menu. | **Effectively yes.** Official guidance says missing macOS features should be implemented with native modules using AppKit instead of UIKit. | **Not recommended for menu-bar-only Laborer.** Consider only if a substantial native windowed app is already planned. |
| **SwiftUI / AppKit** | First-party `MenuBarExtra` for menu or window-style popovers; `NSStatusItem` for lower-level control | No React/TypeScript. | Native Unix-socket/XPC client and Service Management integration are straightforward. Keep the daemon as a separate Node process. | Xcode handles archives, Developer ID signing, hardened runtime, and notarization. Use the App Store or add a separate updater for direct distribution. | Smallest dependency surface and best macOS behavior. `MenuBarExtra` is macOS 13+; AppKit covers older targets. | **Yes.** | **Recommended for a small icon + command menu.** |
| **Neutralinojs 6.7** | First-party `os.setTray`, checked/disabled native items, macOS template icons; first-party long-running process API | React and the TypeScript client package work; uses the system webview. | Can connect to the daemon or spawn a process. Its command API accepts a command string, so a structured daemon IPC seam is safer than interpolating roots or secrets into shell commands. | CLI builds universal/arm64/x64 binaries and a minimal `.app`; built-in updater replaces `resources.neu`. Official docs delegate richer app-bundle automation to community scripts and do not yet document a macOS installer. | Project claims about 2 MB uncompressed / 0.5 MB compressed for a simple app. v6.7.0 shipped in April 2026. Smaller ecosystem and less complete release tooling than Tauri. | **No.** | **Good spike candidate, not the default production choice.** |

Bundle-size figures above are framework-published minimal/example figures, not
apples-to-apples Laborer measurements. A real prototype should measure signed
universal `.app` size, idle RSS, cold start, and update artifact size. In
particular, packaging the existing Node daemon and its dependencies can erase
much of Tauri's or Neutralino's shell-size advantage.

## Option details and primary sources

### Tauri 2

Tauri's system-tray guide says the tray API is available from JavaScript and
Rust and documents native menu and tray events. The macOS application handle
also exposes `ActivationPolicy::Accessory`, which removes the normal Dock/app
switcher presence appropriate for a menu-bar utility.

- [Tauri system tray](https://v2.tauri.app/learn/system-tray/)
- [Tauri `AppHandle::set_activation_policy`](https://docs.rs/tauri/latest/x86_64-apple-darwin/tauri/struct.AppHandle.html#method.set_activation_policy)

The existing daemon can remain independently installed. If a future product
bundles it, Tauri's sidecar mechanism accepts any executable, supports
architecture-qualified binaries, and can expose stdout/stdin to Rust or
JavaScript. Because `next/` currently executes TypeScript on Node, such a bundle
must include a supported Node runtime or first compile the daemon into an
independent executable; the Rust shell does not itself run the daemon's
TypeScript.

- [Tauri external binaries / sidecars](https://v2.tauri.app/develop/sidecar/)

For direct distribution, Tauri documents Developer ID signing and notarization.
Its updater produces a macOS app archive plus a separate signature and can
consume static JSON or a dynamic update server.

- [Tauri macOS code signing and notarization](https://v2.tauri.app/distribute/sign/macos/)
- [Tauri updater](https://v2.tauri.app/plugin/updater/)

Tauri uses the system webview rather than shipping a browser engine and says a
minimal app can be below 600 KB. React is useful if Laborer wants a rich
popover; for a native menu created in Rust, React is unnecessary.

- [Tauri overview and app-size claim](https://tauri.app/start/)
- [Tauri 2 stable announcement](https://tauri.app/blog/tauri-2-0/)
- [Tauri 2.11.5 crate release](https://docs.rs/crate/tauri/2.11.5)

### Electron

Electron has the most direct TypeScript implementation: construct `Tray` and a
native `Menu` in the main process, keep the app alive without windows, and hide
the Dock icon. A React renderer is optional. This lets the initial companion
ship with no renderer at all, while retaining Electron's Chromium
`BrowserWindow`/`WebContentsView` path when Laborer grows a real application
surface.

- [Electron tray guide](https://www.electronjs.org/docs/latest/tutorial/tray)
- [Electron `Tray` API](https://www.electronjs.org/docs/latest/api/tray)
- [Electron Dock API](https://www.electronjs.org/docs/latest/api/dock)
- [Electron web-content options](https://www.electronjs.org/docs/latest/tutorial/web-embeds)

Forge is Electron's recommended packaging path and uses the official signing and
notarization packages. `autoUpdater` is built on Squirrel.Mac and requires the
macOS app to be signed.

- [Electron application packaging](https://www.electronjs.org/docs/latest/tutorial/application-distribution)
- [Electron code signing](https://www.electronjs.org/docs/latest/tutorial/code-signing)
- [Electron `autoUpdater`](https://www.electronjs.org/docs/latest/api/auto-updater/)

Electron intentionally embeds Chromium and Node. Its maintainers explicitly
recommend another option where small disk footprint is required and estimate a
usual zipped app at 80–100 MB. The project is highly active: the official
release index lists 43.2.0 on 2026-07-21.

- [Why Electron](https://www.electronjs.org/docs/latest/why-electron)
- [Electron stable releases](https://releases.electronjs.org/release?channel=stable)

### React Native macOS

React Native macOS is a Microsoft-maintained fork that builds native macOS apps
with React, and it remains active. Version 0.81.8 was released on 2026-06-26.

- [React Native macOS repository](https://github.com/microsoft/react-native-macos)
- [React Native macOS releases](https://github.com/microsoft/react-native-macos/releases)
- [React Native macOS getting started](https://microsoft.github.io/react-native-macos/docs/getting-started)

Its documented native extension model is the key fit issue. The project says
macOS modules and components follow the iOS model but use AppKit instead of
UIKit. The documented API surface does not include a first-party status-item
abstraction, so Laborer would need an AppKit host/native module for
`NSStatusItem`, activation policy, and menu lifecycle. React Native could then
render a substantial popover or window, but Tauri provides that division of
labor more directly for this app.

- [React Native macOS native development](https://microsoft.github.io/react-native-macos/docs/guides/native-development)
- [Apple `NSStatusItem`](https://developer.apple.com/documentation/appkit/nsstatusitem)

### Native SwiftUI / AppKit

Apple's `MenuBarExtra` is specifically designed for a persistent system-menu
control, supports both a normal command menu and a window-style rich popover,
and documents an `LSUIElement` menu-only utility configuration. AppKit's
`NSStatusItem` remains the lower-level alternative.

- [Apple `MenuBarExtra`](https://developer.apple.com/documentation/swiftui/menubarextra)
- [Apple `NSStatusItem`](https://developer.apple.com/documentation/appkit/nsstatusitem)

Apple's `SMAppService` can register a login item or LaunchAgent, subject to user
approval. A registered LaunchAgent is bootstrapped immediately and at later
logins. This is a better ownership model for the daemon than making it an
incidental child of whichever menu shell is chosen.

- [Apple `SMAppService.register()`](https://developer.apple.com/documentation/servicemanagement/smappservice/register())

Outside the Mac App Store, the app and every bundled executable need valid
Developer ID signatures, hardened runtime, and notarization. This applies to
all shell choices, not only Swift.

- [Apple notarization requirements](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)
- [Apple distribution-signed macOS code](https://developer.apple.com/documentation/xcode/creating-distribution-signed-code-for-the-mac/)

### Neutralinojs

Neutralino's first-party API creates/updates a native tray, supports checked and
disabled items and macOS template icons, and can supervise a spawned process.
Its documented React integration uses `@neutralinojs/lib`.

- [Neutralino `os.setTray` and process APIs](https://neutralino.js.org/docs/api/os/)
- [Neutralino with React/frontend libraries](https://neutralino.js.org/docs/getting-started/using-frontend-libraries/)

The project is active and lightweight, but production distribution is the gap.
The CLI can generate a minimal macOS `.app`, while the official overview points
to community build scripts for fuller bundles and leaves macOS installers
undocumented. The built-in updater only replaces application resources; a
framework-server upgrade requires users to download/install the app again.

- [Neutralino distribution overview](https://neutralino.js.org/docs/distribution/overview/)
- [Neutralino auto updater](https://neutralino.js.org/docs/how-to/auto-updater/)
- [Neutralino project size claim](https://neutralino.js.org/)
- [Neutralino repository and latest release](https://github.com/neutralinojs/neutralinojs)

## Recommended architecture

```text
macOS login
    |
    v
LaunchAgent / Service Management  --->  Laborer daemon (Node/Effect)
                                             |
                                             | existing Slack + Runner work
                                             v
                                      per-workspace Runners

menu-bar companion (Electron main process)
    |
    | authenticated, versioned local IPC
    v
daemon control/status endpoint
```

The IPC should be a narrow operator boundary, not access to Runner internals:

1. `status`: daemon identity/version, connection state, and bounded per-binding
   readiness summaries with no tokens, handler output, prompts, or filesystem
   detail not needed by the operator.
2. `stop`: an explicit graceful request equivalent to the existing signal path.
3. `restart`: an explicit user action performed by the service owner, with
   shutdown completion observed before starting a replacement.
4. Event notifications for state changes; silence only marks the UI
   "unresponsive" and never authorizes a kill.
5. A protocol version and local authentication material stored with owner-only
   permissions or in Keychain. Do not reuse the runner-lock listener as this
   endpoint.

Keep Slack tokens in the daemon's existing Keychain-to-environment path. The
companion needs operational summaries, not Slack credentials. For initial local
development, the companion can connect to a daemon launched by the existing
documented command; process installation and LaunchAgent registration can be a
separate product step.

## Recommendation

Use **Electron**, accepting its bundle cost as the price of the desired Chromium
path:

1. Start with no `BrowserWindow` and no React dependency. Create the status icon
   and native command menu from Electron's main process using `Tray` and `Menu`.
2. Keep the Laborer daemon as a distinct service and add the narrow local
   status/control protocol described above. The Electron process is an operator
   client, not a second Runner and not the owner of Slack credentials.
3. When the product needs workspace rows, setup forms, a settings window, or
   embedded web content, add a React renderer behind a `BrowserWindow` or
   `WebContentsView`; the menu-bar lifecycle does not need to change.
4. Package with Electron Forge and add signing, notarization, and `autoUpdater`
   before external distribution.

Tauri remains the best choice if bundle size later outweighs the Chromium
preference. SwiftUI remains the best choice if the scope is permanently only a
tiny native menu. Do not choose React Native macOS for this scope unless Laborer
is already committing to a much larger native React application.

Before product implementation, build one narrow Electron spike that displays
daemon/binding state and performs a graceful restart over the proposed local
protocol. Measure a signed universal build, idle RSS, cold start, and update
artifact. The 80–100 MB compressed framework cost is known; the spike should
confirm that its runtime cost and the future Chromium reuse are acceptable.
