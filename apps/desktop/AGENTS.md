# Desktop App

`apps/desktop/` is the Electron shell for the mission-control interface in `apps/web/`.

- Keep Electron main-process, preload, packaging, update, window, tray, and utility-process concerns in this app.
- Preserve context isolation: expose narrow capabilities through the preload bridge and validate unknown IPC payloads in the main process.
- Keep cross-process domain types and RPC contracts in `packages/shared`; do not duplicate them in Electron handlers.
- Treat renderer panes as views of independently owned terminals and services. Closing, detaching, or recreating a view must not terminate the underlying work.
