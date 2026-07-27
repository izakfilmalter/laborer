---
status: accepted
---

# The macOS companion is an Electron client of a launchd-owned daemon

Laborer's macOS companion will be an Electron application for macOS 13 and newer, distributed for Apple Silicon and Intel. Clicking its menu-bar item opens a compact React status surface, and the same Chromium shell can grow into Laborer's later graphical application. The Laborer daemon remains a separate per-user service owned by `launchd`; the companion observes and explicitly controls it through a narrow local protocol, and closing or crashing the companion does not stop ongoing work.

## Why

Electron has a larger runtime footprint than a native or system-webview shell, but it provides the preferred Chromium rendering engine, a direct TypeScript/React path, and continuity with the planned graphical application. Keeping the daemon outside the UI failure domain preserves active work and makes daemon availability independent of whether anyone is looking at the companion.

## Consequences

- The product needs an explicit, versioned daemon status/control boundary; the existing Runner lock and runtime snapshots are not that boundary.
- Packaging must provide an executable daemon service, LaunchAgent registration, signing, and compatible updates for both architectures.
- The companion may report suspected unresponsiveness, but only confirmed process exit or explicit operator action may initiate destructive recovery.
- Tauri/WebKit, React Native macOS, and a permanently native SwiftUI shell are not the planned product path.
