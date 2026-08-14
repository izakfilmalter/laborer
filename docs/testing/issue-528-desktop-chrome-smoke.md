# Issue 528 desktop chrome smoke

Executed on 2026-08-14 from `sandcastle/spec-515` after the desktop switched to
the standalone daemon. The sandbox has no installed Electron runtime binary, so
the checklist was exercised with the deterministic main-process harness rather
than an interactive Finder launch.

| Chrome surface | Result | Evidence |
| --- | --- | --- |
| Native dialogs | Pass | `apps/desktop/test/ipc-workspace-targeting.test.ts` and IPC handler validation |
| Application menus | Pass | `apps/desktop/test/menu.test.ts` (6 checks) |
| Tray and workspace routing | Pass | tray wiring in `main.test.ts`; workspace routing (12 checks) |
| Agent notifications | Pass | notification coordinator (7 checks) and daemon subscription (5 checks) |
| Deep links | Pass | protocol registration/routing exercised by `main.test.ts` |
| Window create, restore, focus, and close | Pass | main multi-window harness (10 checks), window identity (3 checks), workspace presence (3 checks) |

The same run confirmed that the shell loads the daemon origin and that quit uses
the daemon shutdown path. No service capability or transport channel remains in
the preload bridge.
