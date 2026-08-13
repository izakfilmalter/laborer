# PRD: Browser-Compatible Transport Layer

## Problem Statement

The laborer web app (`apps/web/`) is completely non-functional outside of Electron. Every data-plane connection — server RPC, terminal RPC, terminal PTY I/O, and LiveStore sync — requires Electron's `MessagePort` IPC, which is brokered through the Electron main process via `ipcRenderer`/`ipcMain`/`utilityProcess.fork()`. When `window.desktopBridge` is absent (i.e., running in a plain browser), all `acquire*Port()` calls return `null`, RPC client atoms call `Effect.die()`, LiveStore sync hangs indefinitely, and terminal panes show permanent "disconnected" state.

This makes it impossible to:

- Run Playwright E2E tests against the web app without launching the full Electron shell.
- Develop and iterate on UI features using just `vite dev` in a browser.
- Run the web app as a standalone browser client connected to backend services over the network (a prerequisite for any future web-only deployment).


## Solution

Add HTTP and WebSocket transport alternatives so the web app works in any browser without Electron. The web app auto-detects its environment at runtime: if `window.desktopBridge` exists, use MessagePort (current path, zero changes); if not, connect to backend services over HTTP/WebSocket using the same RPC contracts.

Backend services (server, terminal) gain HTTP/WebSocket endpoints that run alongside their existing MessagePort handlers. The E2E test infrastructure is updated so Playwright tests exercise the real application through the browser transport path, validating both the UI and the transport layer end-to-end.

## User Stories

1. As a developer running Playwright E2E tests, I want the web app to connect to backend services over HTTP/WebSocket, so that tests run in a plain browser without requiring Electron.
2. As a developer using `vite dev`, I want the web app to detect that it's not inside Electron and automatically fall back to HTTP/WebSocket transport, so that I can iterate on UI in any browser.
3. As a developer, I want the server utility process to serve `LaborerRpcs` over HTTP (alongside MessagePort), so that browser clients can call the same RPC endpoints without Electron IPC.
4. As a developer, I want the terminal utility process to serve `TerminalRpcs` over HTTP (alongside MessagePort), so that browser clients can spawn, resize, kill, and list terminals without Electron IPC.
5. As a developer, I want terminal PTY I/O (keystroke input, terminal output) to flow over a multiplexed WebSocket when MessagePort is unavailable, so that terminal panes work in any browser.
6. As a developer, I want the multiplexed terminal WebSocket to carry terminal ID framing, so that all terminals share a single connection (matching VS Code's single Management WebSocket pattern) rather than opening one connection per terminal.
7. As a developer, I want LiveStore sync to work over WebSocket when the Electron sync port is unavailable, so that LiveStore data propagates between the web app and the server in browser-only mode.
8. As a developer, I want the environment detection to be automatic (check for `window.desktopBridge`), so that no build-time configuration or env vars are needed to switch transport modes.
9. As a developer, I want the existing MessagePort transport to remain the default when running inside Electron, so that the desktop app's performance characteristics (structured clone, zero-copy ArrayBuffer transfer) are unchanged.
10. As a developer, I want the RPC client atoms (`LaborerClient`, `TerminalServiceClient`) to use an environment-aware protocol provider, so that React components don't know or care which transport is active.
11. As a developer, I want the terminal pane hook to support both MessagePort and WebSocket data channels transparently, so that terminal rendering code is transport-agnostic.
12. As a developer, I want the LiveStore worker to accept either a MessagePort or a WebSocket URL for sync, so that the store initialization path doesn't hardcode Electron assumptions.
13. As a developer, I want the Playwright E2E global setup to start backend services as standalone Node.js HTTP servers (via `turbo dev`), so that browser-based tests connect over HTTP/WS naturally.
14. As a developer, I want the existing E2E test specs to pass against the HTTP/WebSocket transport without modification, so that transport compatibility is validated by the same tests that validate the UI.
16. As a developer, I want the WebSocket terminal data protocol to be defined in `packages/shared`, so that both the server (terminal process) and client (web app) share the same framing contract.
17. As a developer, I want JSON serialization to be used for the HTTP transport (matching Effect RPC's `RpcSerialization.layerJson`), so that requests/responses are debuggable with standard browser dev tools.
18. As a developer, I want the multiplexed terminal WebSocket to handle connection drops gracefully (reconnect, replay buffered output), so that transient network issues don't permanently break terminal panes.
19. As a developer, I want the server and terminal processes to log which transport mode is active at startup, so that debugging transport issues is straightforward.
20. As a developer, I want the web app to show a clear connection status indicator when using HTTP/WS transport, so that I can see at a glance whether the backend is reachable.
21. As a developer, I want unit tests for the new transport modules (HTTP client protocol, WebSocket terminal data, WebSocket sync), using in-memory mocks where appropriate, so that transport logic is tested in isolation.
22. As a developer, I want browser-specific transport tests that use real `MessageChannel` APIs (following VS Code's `ipc.mp.test.ts` pattern), so that the MessagePort path is validated in a browser environment.
23. As a developer, I want the E2E tests to serve as the integration tests for the full HTTP/WS transport path, so that the real WebSocket/HTTP connections are validated end-to-end without separate integration test infrastructure.

## Polishing Requirements

- Verify that the Electron desktop app is completely unaffected — MessagePort transport should be bit-for-bit identical in behavior, with no regressions in latency or throughput.
- Ensure the HTTP/WS fallback activates cleanly without console errors, warnings, or visible flicker when `window.desktopBridge` is absent.
- Confirm that terminal PTY I/O latency over WebSocket is acceptable for interactive use (typing, scrolling) during development and testing.
- Verify that LiveStore sync over WebSocket correctly handles the initial pull, incremental pushes, and conflict resolution — matching the MessagePort sync behavior.
- Check that the multiplexed terminal WebSocket reconnects gracefully after a transient disconnection without losing terminal state (the headless xterm replay buffer should cover this).
- Ensure all existing E2E test specs pass in the browser-only (HTTP/WS) mode without test modifications.
- Verify that `vite dev` in a browser (without Electron) shows a working dashboard, can list projects, and can interact with terminals.
- Remove any leftover `console.log` debug statements from the RPC transport modules (there are several in the current MessagePort transport code).
- Confirm that the server and terminal health endpoints remain functional and are used by the E2E global setup for readiness detection.

## Implementation Decisions

### Environment Detection

The web app detects its transport mode at runtime by checking for `window.desktopBridge`. This mirrors VS Code's approach (separate entry points register different services) but adapted for a single Vite app:

- If `window.desktopBridge` exists: use MessagePort (current behavior, no changes).
- If `window.desktopBridge` is absent: use HTTP for RPC, WebSocket for terminal data and LiveStore sync.
- Service URLs in browser mode come from Vite env vars (`VITE_SERVER_URL`, `VITE_TERMINAL_URL`) which are already partially used in dev mode.

### HTTP RPC Client Protocol (packages/shared)


### WebSocket Terminal Data Transport (packages/shared)

A multiplexed WebSocket protocol for terminal PTY I/O, following VS Code's single Management WebSocket pattern:

- One WebSocket connection carries data for all terminals.
- Messages are framed with a terminal ID prefix so the client can demultiplex output to the correct terminal pane.
- The protocol supports: data (output from PTY), input (keystrokes to PTY), resize, and ack (flow control).
- The framing contract is defined in `packages/shared` so both the terminal process (server) and web app (client) share it.
- Reconnection logic with buffered replay handles transient disconnections.

### WebSocket LiveStore Sync Transport (apps/web)

The existing `messageport-sync.ts` speaks the `SyncWsRpc` protocol. A WebSocket-based adapter sends the same `SyncWsRpc.Pull`/`SyncWsRpc.Push` RPCs over a WebSocket instead of a MessagePort. The server's `sync-backend.ts` already handles the protocol — it just needs a WebSocket listener alongside the MessagePort one.

### Server-Side Changes

**Server utility process (packages/server):**
- Add an HTTP server (using Effect's `HttpServer`) that serves `LaborerRpcs` via `RpcServer.layerProtocolHttp`.
- Add a WebSocket endpoint for LiveStore sync that serves `SyncWsRpc` handlers.
- The HTTP server runs alongside the existing MessagePort handler. In utility process mode, both are active. In standalone mode (e.g., `turbo dev`), only HTTP is needed.

**Terminal utility process (packages/terminal):**
- Add an HTTP server that serves `TerminalRpcs` via `RpcServer.layerProtocolHttp`.
- Add a WebSocket endpoint for multiplexed terminal PTY I/O.
- Both run alongside the existing MessagePort handlers.

### Web App Atoms (apps/web/src/atoms)

The `LaborerClient` and `TerminalServiceClient` atoms switch from hardcoded `acquireServicePort()` to an environment-aware protocol provider:

- A shared utility provides the correct `RpcClient.Protocol` layer based on `window.desktopBridge` presence.
- MessagePort path: unchanged (acquires port via desktop bridge).
- HTTP path: uses the new shared HTTP RPC client protocol layer with the service URL from env vars.
- The switch is transparent to all React components that consume `LaborerClient.query()` or `TerminalServiceClient.mutation()`.

### Terminal Pane Hook (apps/web/src/hooks)

The terminal pane hook gains a WebSocket data channel implementation alongside the existing MessagePort one:

- When `desktopBridge` is present: use `acquireTerminalDataPort()` and MessagePort (current behavior).
- When absent: connect to the terminal service's multiplexed WebSocket endpoint, subscribe to the specific terminal ID.
- The hook exposes the same interface (`send`, `connectionStatus`, `onData`) regardless of transport.

### LiveStore Worker (apps/web)

The LiveStore worker currently waits for a MessagePort via `postMessage`. In browser-only mode:

- The main thread sends a WebSocket URL instead of a MessagePort.
- The worker uses `makeWsSync()` (WebSocket-based sync) instead of `makeMessagePortSync()`.
- The worker detects which sync mode to use based on the message type it receives from the main thread.

### E2E Infrastructure (apps/web/e2e)

The global setup already starts services via `turbo dev` and health-checks them. Changes:

- Ensure the web app is served with the correct `VITE_SERVER_URL` and `VITE_TERMINAL_URL` env vars pointing to the running services.
- Verify that the browser-based Playwright tests connect via HTTP/WS (since there's no Electron, `desktopBridge` is absent).
- No changes to individual test specs — they should pass as-is.

## Testing Decisions

### What makes a good test

Tests should verify external behavior from the consumer's perspective, not internal implementation details. For transport modules, this means testing that "a message sent on one end arrives correctly on the other end" rather than testing internal queue management or listener attachment.

### Unit tests for new transport modules

**HTTP RPC client protocol (packages/shared):**
- Test that the layer correctly composes `RpcClient.layerProtocolHttp`, `RpcSerialization.layerJson`, and `FetchHttpClient.layer`.
- Use in-memory mocks (Effect's test utilities) to verify request/response flow without a real HTTP server.

**WebSocket terminal data transport (packages/shared):**
- Test the framing protocol: encode/decode with terminal ID, message type discrimination (data, input, resize, ack).
- Test multiplexing: multiple terminals on one connection, messages routed correctly.
- Use in-memory stream mocks (following VS Code's `QueueProtocol` pattern from `ipc.test.ts`) rather than real WebSockets.
- Prior art: VS Code's `ipc.net.test.ts` tests WebSocket frame parsing with `FakeNodeSocket` mocks.

**WebSocket LiveStore sync transport (apps/web):**
- Test that the `SyncWsRpc` protocol works over WebSocket transport.
- Verify initial pull, incremental push, and reconnection behavior.
- Prior art: the existing `messageport-sync.ts` has no unit tests; test the new WebSocket adapter in isolation with a mock WebSocket.

### Browser-specific tests

- A browser MessagePort transport test (following VS Code's `ipc.mp.test.ts`) that uses real `MessageChannel` APIs to verify the existing MessagePort transport in a browser environment.
- These run in the browser unit test suite (vitest with jsdom or a Playwright browser runner).

### E2E tests as integration tests

- The existing E2E test specs (`dashboard.spec.ts`, `terminal-interaction.spec.ts`, `workspace-lifecycle.spec.ts`, etc.) running in Playwright serve as the integration tests for the full HTTP/WS transport path.
- No separate integration test infrastructure is needed — if the E2E tests pass in browser-only mode, the transport is working correctly.
- The E2E global setup ensures backend services are running and healthy before tests start.

## Out of Scope

- **Electron IPC changes**: The existing MessagePort transport in the desktop app is not modified. This PRD only adds alternatives for when Electron is absent.
- **Remote/cloud deployment**: While the HTTP/WS transport enables running the web app against remote services, deploying services to a remote server (authentication, TLS, multi-tenant isolation) is out of scope.
- **WebSocket compression**: The terminal data WebSocket uses uncompressed messages initially. Permessage-deflate or custom compression can be added later if bandwidth is a concern.
- **Connection token / authentication**: VS Code's remote connection uses a connection token handshake. For local development and Playwright tests, no authentication is needed. Authentication is a future concern for remote deployment.
- **Removing the MessagePort transport**: MessagePort remains the primary transport for the Electron app. It is faster (structured clone, zero-copy ArrayBuffer transfer) and should stay as the default.
- **File watcher HTTP/WS transport**: The file-watcher service (`packages/file-watcher`) is consumed only by the server process (not the web app directly), so it doesn't need an HTTP/WS endpoint for the browser.

## Further Notes

### VS Code's architecture as reference

VS Code's approach is documented in detail from our investigation:

- **Single multiplexed WebSocket**: VS Code routes ALL service traffic (terminals, file system, extensions, telemetry) through one Management WebSocket. Terminal I/O is the `'remoteterminal'` channel, identified by `persistentProcessId`. We follow this pattern for the terminal data WebSocket.
- **`IMessagePassingProtocol`**: VS Code's core transport abstraction is `send(buffer)` + `onMessage`. Effect RPC's `RpcClient.Protocol` / `RpcServer.Protocol` serve the same role in our architecture.
- **Service registration**: VS Code registers different service implementations for electron vs browser via separate module entry points. We achieve the same with runtime `desktopBridge` detection since we have a single Vite build.
- **Testing**: VS Code uses in-memory `QueueProtocol` mocks for IPC unit tests, real `MessageChannel` for browser transport tests, and smoke tests for end-to-end WebSocket validation.

### Existing code to reuse

- **`SyncWsRpc` protocol** (`apps/web/src/livestore/messageport-sync.ts`): Already speaks the right protocol for LiveStore sync. Just needs a WebSocket transport alternative.
- **`RpcMessagePort` interface** (`packages/shared/src/rpc-transport-messageport.ts:45-55`): Already handles both Node.js and Web MessagePort API styles. The abstraction is clean.
- **E2E global setup** (`apps/web/e2e/global-setup.ts`): Already starts services via `turbo dev`, creates temp repos, health-checks endpoints. Needs minimal changes.

### Deleted code that was on the right track

Comments in the codebase reference `use-terminal-websocket.ts` and `terminal-ws.ts` as former WebSocket-based equivalents that were removed when the MessagePort architecture was implemented. The new implementation should follow the same patterns but with the multiplexed WebSocket approach.
