# Issues: Migrate from xterm.js to ghostty-web with Terminal Persistence

Parent PRD: [PRD-ghostty-web-migration.md](./PRD-ghostty-web-migration.md)

## Dependency Graph

```
#1 (tracer) ─┬─ #2 (fit/resize) ──────────────────┐
             ├─ #3 (theme/font)                    │
             ├─ #4 (keyboard)                      │
             ├─ #5 (links/title)                   │
             │                                     │
#6 (esc buf) ── #7 (headless) ── #8 (attach) ─┐   │
                                               │   │
                              #9 (router core) │   │
                                    │          │   │
                              #10 (router ctx) ────┤
                                    │          │   │
                              #11 (pty resize) ────┘
                                    │
                              #12 (cleanup) ───────
```

## Summary

| # | Title | Blocked by | Status |
|---|-------|-----------|--------|
| 1 | Tracer bullet: Swap xterm.js for ghostty-web with basic I/O | None | Ready |
| 2 | ghostty-web FitAddon and basic resize | #1 | Blocked |
| 3 | Theme, font, and cursor configuration | #1 | Blocked |
| 4 | Keyboard bypass and prefix mode | #1 | Blocked |
| 5 | Link detection and OSC title changes | #1 | Blocked |
| 6 | Backend: Escape sequence buffering | None | Ready |
| 7 | Backend: Headless terminal state manager | #6 | Blocked |
| 8 | Backend: Race-free WebSocket attach protocol | #7 | Blocked |
| 9 | Frontend: Terminal Session Router (core) | #8 | Blocked |
| 10 | Frontend: Terminal Router context and integration | #1, #9 | Blocked |
| 11 | PTY-first resize | #2, #7, #10 | Blocked |
| 12 | Cleanup: Remove xterm.js and ring buffer | #1-#11 | Blocked |

---

## Issue 1: Tracer bullet: Swap xterm.js for ghostty-web with basic I/O

### What to build

The thinnest possible end-to-end path proving that ghostty-web can replace xterm.js as the terminal renderer. Swap the dependency, initialize WASM, create a ghostty-web Terminal, and wire basic I/O (write PTY output to the terminal, send user keystrokes to the WebSocket). This slice intentionally skips FitAddon, theming, keyboard bypass, link detection, and the session router -- those come in later slices.

Modify `terminal-pane.tsx` to:
- Import `init`, `Terminal` from `ghostty-web` instead of `@xterm/xterm`
- Call `await init()` before creating terminals (idempotent -- safe on subsequent calls)
- Create `new Terminal()` with minimal config (cols, rows, basic defaults)
- Call `terminal.open(containerElement)` to mount the canvas
- Wire `terminal.onData(data => wsSend(data))` for user input
- Wire `terminal.write(data)` for PTY output via the existing `handleTerminalData` callback
- Call `terminal.dispose()` on cleanup
- Remove all xterm.js addon loading code (WebGL, Image, Unicode11, WebLinks, Fit)
- Remove the `@xterm/xterm/css/xterm.css` import

Modify `apps/web/package.json` to:
- Remove all 6 `@xterm/*` dependencies
- Add `ghostty-web` dependency

Modify `vite.config.ts` to:
- Remove `patchXtermEnumPlugin()` (no longer needed)
- Verify `ghostty-vt.wasm` is served correctly by Vite dev server

### Acceptance criteria

- [ ] ghostty-web WASM binary loads without errors on app startup
- [ ] A terminal pane renders a canvas element in its container
- [ ] Typing in the terminal sends keystrokes to the backend PTY via WebSocket
- [ ] PTY output (e.g., shell prompt, command output) renders visibly in the terminal
- [ ] Terminal disposes cleanly on pane close (no console errors, no leaked listeners)
- [ ] No `@xterm/*` imports remain in `terminal-pane.tsx`
- [ ] `patchXtermEnumPlugin` is removed from `vite.config.ts`
- [ ] Tests: ghostty-web Terminal lifecycle (init, open, write, onData, dispose) verified through public API
- [ ] Tests: WASM initialization is idempotent (calling init() twice does not error)

### TDD approach

**RED-GREEN loop (vertical slices, one test at a time):**

1. Test that `init()` resolves without error and is idempotent
2. Test that `new Terminal()` creates an instance with expected default properties (cols, rows)
3. Test that `terminal.open(container)` mounts a canvas child into the provided DOM element
4. Test that `terminal.write(data)` does not throw and accepts both string and Uint8Array
5. Test that `terminal.onData` fires a callback when input is simulated
6. Test that `terminal.dispose()` removes the canvas and cleans up event listeners

### Blocked by

None -- can start immediately.

### User stories addressed

- User story 1: terminals render using ghostty-web's WASM-based parser
- User story 2: terminal rendering at 60fps via canvas
- User story 14: WASM initialization happens once and is idempotent
- User story 22: ghostty-web WASM binary served correctly in dev builds

---

## Issue 2: ghostty-web FitAddon and basic resize

### What to build

Wire ghostty-web's built-in `FitAddon` to make terminals responsive to container size changes. After `terminal.open()`, load the FitAddon, call `fit()` to set initial dimensions, and send the resulting cols/rows to the backend via the existing resize RPC. Set up a `ResizeObserver` with 100ms debounce (matching the current `RESIZE_DEBOUNCE_MS`) that re-fits on container resize and sends updated dimensions to the backend.

This slice uses the current resize flow (fit first, then RPC). The PTY-first resize (propose -> RPC -> resize) comes in Issue 11.

### Acceptance criteria

- [ ] ghostty-web `FitAddon` is loaded and `fit()` called after `terminal.open()`
- [ ] Initial terminal dimensions (cols/rows) are sent to the backend resize RPC on mount
- [ ] Container resize triggers re-fit with 100ms debounce
- [ ] Re-fit sends updated cols/rows to the backend resize RPC
- [ ] Terminal canvas scales correctly when panel is resized via drag
- [ ] Tests: `fit()` produces valid positive cols/rows values
- [ ] Tests: resize observer triggers dimension update callback

### TDD approach

1. Test that `FitAddon` can be loaded into a terminal via `loadAddon()`
2. Test that `fit()` sets `terminal.cols` and `terminal.rows` to positive integers based on container size
3. Test that a resize callback is invoked with new dimensions when the container size changes

### Blocked by

- Blocked by "Tracer bullet: Swap xterm.js for ghostty-web with basic I/O"

### User stories addressed

- User story 20: terminal-with-sidebars layout works correctly with ghostty-web resize events

---

## Issue 3: Theme, font, and cursor configuration

### What to build

Apply the full visual configuration to ghostty-web terminals so they look identical to the current xterm.js terminals. This includes the complete zinc color scale theme (16 ANSI colors + background/foreground/cursor/selection), the JetBrains Mono font stack, font size 13px, line height 1.2, cursor blink with bar style, and 100k line scrollback.

Handle ghostty-web's use of a `contenteditable` element for input by setting `caretColor: transparent` on the terminal container to hide the browser's native caret.

Refer to PRD section "Module 3: Frontend ghostty-web Terminal Component" for the exact theme values.

### Acceptance criteria

- [ ] Terminal background is zinc-950 (`#09090b`), foreground is zinc-50 (`#fafafa`)
- [ ] All 16 ANSI colors match the current zinc-based palette
- [ ] Cursor renders as a blinking bar
- [ ] Font renders as JetBrains Mono (with Fira Code, Cascadia Code, Menlo fallbacks)
- [ ] Font size is 13px with 1.2 line height
- [ ] Scrollback is configured to 100,000 lines
- [ ] Browser's native contenteditable caret is hidden (caretColor: transparent)
- [ ] Selection background uses zinc-800 with alpha transparency
- [ ] Tests: terminal options reflect the configured theme colors after creation
- [ ] Tests: scrollback configuration is accepted without error

### TDD approach

1. Test that `new Terminal({ theme: {...} })` applies background and foreground colors to `terminal.options`
2. Test that cursor style and blink settings are reflected in `terminal.options`
3. Test that scrollback value is accepted (create terminal with `scrollback: 100_000`, verify no error)

### Blocked by

- Blocked by "Tracer bullet: Swap xterm.js for ghostty-web with basic I/O"

### User stories addressed

- User story 12: terminal theme preserved identically
- User story 13: terminal scrollback preserved in ghostty-web's in-memory buffer

---

## Issue 4: Keyboard bypass and prefix mode

### What to build

Wire ghostty-web's `attachCustomKeyEventHandler` with the existing keyboard bypass logic from `terminal-keys.ts`. The bypass behavior must be preserved exactly:

- **Cmd+W** (`isExactMetaW`): returns false so the event bubbles to close the pane
- **Cmd+Shift+Enter** (`isMetaShiftEnter`): returns false so the event bubbles to toggle fullscreen
- **Ctrl+B** (`isExactCtrlB`): enters prefix mode; returns false. The next keydown also returns false, then prefix mode exits. Prefix mode times out after 1500ms (`PREFIX_MODE_TIMEOUT`).

The existing pure functions in `terminal-keys.ts` require no changes. This issue wires them to ghostty-web's handler instead of xterm.js's.

### Acceptance criteria

- [ ] `attachCustomKeyEventHandler` is called on the ghostty-web terminal after open
- [ ] Cmd+W is intercepted and does not reach the terminal (returns false)
- [ ] Cmd+Shift+Enter is intercepted and does not reach the terminal
- [ ] Ctrl+B enters prefix mode; the next key is also intercepted
- [ ] Prefix mode times out after 1500ms and reverts to normal mode
- [ ] Normal printable keys return true and are handled by ghostty-web
- [ ] Tests: bypass handler returns false for Cmd+W keydown events
- [ ] Tests: bypass handler returns false for Cmd+Shift+Enter keydown events
- [ ] Tests: Ctrl+B enters prefix mode, next key returns false, subsequent keys return true
- [ ] Tests: prefix mode clears after 1500ms timeout

### TDD approach

1. Test that `attachCustomKeyEventHandler` accepts a handler function without error
2. Test that the handler returns `false` for a Cmd+W keydown event object
3. Test that the handler returns `false` for a Cmd+Shift+Enter keydown event object
4. Test that Ctrl+B sets prefix mode, next key returns false, third key returns true
5. Test that prefix mode resets after 1500ms (use fake timers)

### Blocked by

- Blocked by "Tracer bullet: Swap xterm.js for ghostty-web with basic I/O"

### User stories addressed

- User story 9: existing keyboard bypass behavior preserved exactly

---

## Issue 5: Link detection and OSC title changes

### What to build

Enable clickable URL detection and terminal title tracking in ghostty-web terminals.

**Link detection:** Register ghostty-web's built-in link providers -- `OSC8LinkProvider` for explicit hyperlinks and `UrlRegexProvider` (or equivalent) for auto-detected URLs in terminal output. When a link is clicked (Cmd+Click), call the existing `openExternalUrl()` function to open it in the user's browser.

**Title changes:** Subscribe to ghostty-web's `onTitleChange` event and propagate the title to the existing terminal UI (tab labels, window title). This replaces the implicit title tracking that xterm.js provided.

### Acceptance criteria

- [ ] URLs in terminal output are visually indicated as clickable
- [ ] Cmd+Click on a URL opens it via `openExternalUrl()`
- [ ] OSC 8 hyperlinks (explicit terminal hyperlinks) are detected and clickable
- [ ] `onTitleChange` fires when the shell sets a window title (OSC 0/2 sequences)
- [ ] Title changes propagate to the terminal pane's UI
- [ ] Tests: link provider registration does not throw
- [ ] Tests: `onTitleChange` callback fires when a title-setting escape sequence is written

### TDD approach

1. Test that `registerLinkProvider()` accepts a provider without error
2. Test that writing an OSC title sequence (`\x1b]0;My Title\x07`) to the terminal fires the `onTitleChange` event with `"My Title"`
3. Test that the link click callback receives the URL string

### Blocked by

- Blocked by "Tracer bullet: Swap xterm.js for ghostty-web with basic I/O"

### User stories addressed

- User story 10: clickable URLs detected automatically
- User story 25: OSC title change events forwarded to UI

---

## Issue 6: Backend: Escape sequence buffering

### What to build

Add an escape sequence buffering layer in the `@laborer/terminal` package that wraps raw PTY `onData` callbacks to prevent incomplete VT escape sequences from reaching subscribers.

Create a `createBufferedDataHandler(onData: (data: string) => void): (data: string) => void` function that:
- Forwards complete data immediately
- Holds back a trailing bare `\x1b` (could be start of any escape sequence)
- Holds back a trailing `\x1b[` (incomplete CSI sequence)
- Holds back a trailing `\x1b[` followed by digits/semicolons (e.g., `\x1b[38;5`) until the final command byte arrives
- Flushes the held-back fragment when the next data chunk arrives and completes it

Wire this handler around the PTY `onData` callback in the terminal manager, so both the headless terminal (Issue 7) and live subscribers receive only complete sequences.

Refer to PRD section "Module 1: Backend: Headless Terminal State Manager" for the buffering specification. Mux's `createBufferedDataHandler` in `.reference/mux/src/node/services/ptyService.ts` (lines 50-76) is the reference implementation.

### Acceptance criteria

- [ ] `createBufferedDataHandler` is implemented and exported
- [ ] Complete text passes through immediately
- [ ] Trailing `\x1b` is held back until next chunk completes or extends it
- [ ] Trailing `\x1b[` is held back
- [ ] Trailing `\x1b[38;5` (incomplete CSI with parameters) is held back
- [ ] Held-back fragments are prepended to the next chunk and forwarded when complete
- [ ] The PTY `onData` callback in terminal manager uses the buffered handler
- [ ] Tests: plain text "hello" passes through immediately
- [ ] Tests: "hello\x1b" holds back `\x1b`, next chunk "[31m" flushes "hello\x1b[31m"
- [ ] Tests: "\x1b[" alone is held back, "1;2H" completes it as "\x1b[1;2H"
- [ ] Tests: "\x1b[38;5" is held back, ";196m" completes it as "\x1b[38;5;196m"
- [ ] Tests: chunk with no trailing escape passes through entirely

### TDD approach

1. Test that plain text without escape sequences passes through unchanged
2. Test that a trailing `\x1b` is held back and the preceding text is forwarded
3. Test that a subsequent chunk completing the sequence flushes the full sequence
4. Test that `\x1b[` alone is held back entirely (no output)
5. Test that `\x1b[38;5` (digits/semicolons without command byte) is held back
6. Test that multiple consecutive chunks with incomplete sequences accumulate correctly
7. Test that a chunk ending with a complete sequence passes through entirely

### Blocked by

None -- can start immediately (parallel with Issue 1).

### User stories addressed

- User story 6: incomplete escape sequences buffered on the backend

---

## Issue 7: Backend: Headless terminal state manager

### What to build

Replace the ring buffer with a headless xterm terminal per terminal session in the `@laborer/terminal` package. Each terminal gets an `@xterm/headless` Terminal instance with `@xterm/addon-serialize` that mirrors all PTY output. This provides compact screen state serialization (~4KB vs 5MB ring buffer) and backend device query handling.

Add `@xterm/headless` and `@xterm/addon-serialize` as dependencies of `packages/terminal`.

For each terminal:
- Create a headless `Terminal` instance (matching the PTY's cols/rows) with `allowProposedApi: true`
- Load `SerializeAddon`
- Write all PTY output to the headless terminal (using the buffered handler from Issue 6)
- Forward the headless terminal's `onData` output (device query responses like DA1/DSR) back to the PTY via `ptyWrite`
- Resize the headless terminal in sync with the real PTY on resize events
- Expose `getScreenState(terminalId): string` that calls `serializeAddon.serialize()`
- Dispose the headless terminal when the terminal session is removed

Refer to PRD section "Module 1: Backend: Headless Terminal State Manager" and Mux's `terminalService.ts` (lines 207-238, 838-848) for the reference implementation.

### Acceptance criteria

- [ ] `@xterm/headless` and `@xterm/addon-serialize` added to terminal package dependencies
- [ ] Headless terminal created per terminal session with matching dimensions
- [ ] All PTY output is written to the headless terminal
- [ ] `getScreenState(terminalId)` returns a non-empty string of VT escape sequences for terminals with output
- [ ] `getScreenState(terminalId)` returns empty string for terminals with no output
- [ ] Device query sequences (e.g., DA1 `\x1b[0c`) produce responses forwarded to the PTY
- [ ] Headless terminal is resized when the real PTY is resized
- [ ] Headless terminal is disposed when the terminal session is removed
- [ ] Serialized state correctly includes alternate buffer switch sequence for terminals in alternate screen mode
- [ ] Tests: write output, call getScreenState, verify non-empty VT escape sequences returned
- [ ] Tests: write DA1 query to headless terminal, verify response forwarded to PTY callback
- [ ] Tests: resize headless terminal, verify serialized state reflects new dimensions
- [ ] Tests: alternate screen mode serialization includes `\x1b[?1049h`

### TDD approach

1. Test that creating a headless terminal with SerializeAddon does not throw
2. Test that writing text to the headless terminal and calling `serialize()` returns a string containing the written text
3. Test that writing a DA1 query (`\x1b[0c`) triggers an `onData` callback with a response string
4. Test that resizing the headless terminal changes the serialized state dimensions
5. Test that entering alternate screen mode (`\x1b[?1049h`) and serializing includes the mode switch sequence

### Blocked by

- Blocked by "Backend: Escape sequence buffering"

### User stories addressed

- User story 3: reconnect with ~4KB screen state snapshot
- User story 5: backend headless terminal responds to device queries
- User story 24: headless terminal resized in sync with real PTY

---

## Issue 8: Backend: Race-free WebSocket attach protocol

### What to build

Modify the WebSocket connection handler in `terminal-ws.ts` to implement race-free attach using the headless terminal's screen state serialization. The current flow replays up to 5MB of raw ring buffer data in 128KB chunks. The new flow:

1. On client connect, send `{"type":"status","status":"running"}` (unchanged)
2. Subscribe the client to live PTY output **first** (before serializing)
3. Queue any output that arrives during step 4
4. Call `getScreenState(terminalId)` to serialize the headless terminal
5. Send `{"type":"screenState","data":"<serialized VT sequences>"}` as a single text frame
6. Flush any queued output from step 3
7. Continue streaming live output

Remove the `sendScrollback` function and the chunked replay logic (`SCROLLBACK_CHUNK_SIZE`). The `subscribe` method on the terminal manager should no longer return `scrollback` -- it returns only the `subscriberId`.

Preserve the existing flow control (client sends `{"type":"ack","chars":N}` every 5000 chars) and status control messages.

Refer to PRD section "Module 2: Backend: WebSocket Attach Protocol" and Mux's ORPC `attach` handler for the race-free subscribe-before-serialize pattern.

### Acceptance criteria

- [ ] `sendScrollback` function and `SCROLLBACK_CHUNK_SIZE` constant are removed
- [ ] Terminal manager `subscribe` no longer returns scrollback string
- [ ] On WebSocket connect, client receives `{"type":"screenState","data":"..."}` as first data frame (after status)
- [ ] Screen state is serialized AFTER subscribing to live output (race-free)
- [ ] No output is lost between screen state serialization and live streaming
- [ ] Existing flow control ack protocol still works
- [ ] Existing status control messages (running/stopped/restarted) still work
- [ ] Tests: connect to a terminal with existing output, verify screenState message arrives before any live output
- [ ] Tests: produce PTY output during connect, verify no data lost between screenState and live stream
- [ ] Tests: ack messages are processed correctly after the new attach flow
- [ ] Tests: status messages for stopped/restarted terminals are delivered correctly

### TDD approach

1. Test that on connect, the first data-bearing message has `type: "screenState"`
2. Test that subscribing before serializing ensures output produced during serialization is queued and delivered
3. Test that flow control ack messages are still parsed and processed
4. Test that lifecycle status messages (stopped, restarted) are sent correctly

### Blocked by

- Blocked by "Backend: Headless terminal state manager"

### User stories addressed

- User story 3: reconnect with ~4KB screen state snapshot
- User story 4: backend subscribes to live output before serializing (race-free)

---

## Issue 9: Frontend: Terminal Session Router (core)

### What to build

Create a new `TerminalSessionRouter` class that centralizes WebSocket stream management on the frontend. This replaces the per-component `useTerminalWebSocket` pattern with a shared router that enforces exactly one WebSocket connection per terminal ID.

The router:
- Maintains a `Map<string, SessionState>` where each `SessionState` holds the WebSocket, subscriber callbacks, cached `screenState`, and exit state
- `subscribe(terminalId, callbacks): () => void` -- registers a subscriber with `{ onOutput, onScreenState, onExit }` callbacks. On first subscriber, opens the WebSocket. Returns an unsubscribe function.
- When the WebSocket receives a `{"type":"screenState","data":"..."}` message, caches it and broadcasts to all subscribers
- When the WebSocket receives raw output, broadcasts to all subscribers via `onOutput`
- Late subscribers with a cached screenState receive it immediately via `setTimeout(0)`
- When the last subscriber unsubscribes, closes the WebSocket and deletes the session
- `sendInput(terminalId, data)` -- sends user input to the terminal's WebSocket
- `resize(terminalId, cols, rows)` -- sends resize via the terminal service RPC
- `dispose()` -- closes all WebSockets and clears all sessions

Refer to PRD section "Module 4: Frontend: Terminal Session Router" and Mux's `TerminalSessionRouter.ts` for the reference pattern.

### Acceptance criteria

- [ ] `TerminalSessionRouter` class is implemented with subscribe/unsubscribe/sendInput/resize/dispose
- [ ] First subscriber to a terminal ID opens exactly one WebSocket
- [ ] Second subscriber to the same terminal ID reuses the existing WebSocket
- [ ] screenState is cached per terminal and delivered to late subscribers via setTimeout(0)
- [ ] Last subscriber unsubscribing closes the WebSocket and cleans up the session
- [ ] `sendInput` sends data to the correct terminal's WebSocket
- [ ] `dispose()` closes all WebSockets
- [ ] Tests: subscribing twice to the same terminal creates only one WebSocket
- [ ] Tests: cached screenState is delivered to a late subscriber
- [ ] Tests: unsubscribing the last subscriber closes the WebSocket
- [ ] Tests: subscribing after a previous full unsubscribe creates a new WebSocket

### TDD approach

1. Test that `subscribe()` returns an unsubscribe function
2. Test that two subscriptions to the same terminal ID result in one WebSocket connection (mock WebSocket)
3. Test that screenState from the WebSocket is cached and delivered to a second subscriber added later
4. Test that calling the unsubscribe function from the last subscriber triggers WebSocket close
5. Test that `sendInput()` sends data through the WebSocket for the correct terminal
6. Test that `dispose()` closes all active WebSocket connections

### Blocked by

- Blocked by "Backend: Race-free WebSocket attach protocol" (requires the screenState protocol)

### User stories addressed

- User story 8: centralized session router with cached screen state
- User story 23: terminal disposal cleans up WebSocket connections

---

## Issue 10: Frontend: Terminal Router context and integration

### What to build

Create a `TerminalRouterProvider` React context that provides the `TerminalSessionRouter` to the component tree, and integrate it into `terminal-pane.tsx` to replace the `useTerminalWebSocket` hook.

**TerminalRouterProvider:**
- Creates a `TerminalSessionRouter` instance
- Recreates the router when the backend connection changes (dispose old, create new)
- Provides the router via React context (may be `null` during reconnection)
- Exposes a `useTerminalRouter()` hook

**terminal-pane.tsx integration:**
- Replace `useTerminalWebSocket` with `useTerminalRouter()` + `router.subscribe()`
- On subscribe: clear the terminal, write screenState when received, set loading to false
- Wire `terminal.onData` to `router.sendInput()`
- Handle `null` router during reconnection (skip operations gracefully)
- Wire connection status overlays (loading, disconnected, reconnecting) to router/subscription state

Refer to PRD section "Module 4: Frontend: Terminal Session Router" and Mux's `TerminalRouterContext.tsx` for the context pattern.

### Acceptance criteria

- [ ] `TerminalRouterProvider` wraps the app and provides router via context
- [ ] `useTerminalRouter()` hook returns the router (or null during reconnection)
- [ ] Router is recreated when backend connection changes
- [ ] `terminal-pane.tsx` subscribes to the router instead of using `useTerminalWebSocket`
- [ ] Terminal is cleared and screenState is written on subscribe
- [ ] Loading overlay shows until screenState arrives
- [ ] Disconnected/reconnecting banners reflect router connection state
- [ ] `terminal.onData` sends input via `router.sendInput()`
- [ ] Null router during reconnection does not crash -- operations are skipped gracefully
- [ ] Terminal instance stays alive when tab is hidden (no dispose on hide)
- [ ] Tests: context provides a non-null router when backend is connected
- [ ] Tests: context provides null during backend reconnection
- [ ] Tests: overlays reflect connection state transitions

### TDD approach

1. Test that `TerminalRouterProvider` renders children and provides a router via context
2. Test that `useTerminalRouter()` returns null when no provider is present (or during reconnection)
3. Test that connection status state transitions correctly (connecting -> connected -> disconnected -> reconnecting)
4. Test that the loading overlay is shown until screenState callback fires

### Blocked by

- Blocked by "Tracer bullet: Swap xterm.js for ghostty-web with basic I/O"
- Blocked by "Frontend: Terminal Session Router (core)"

### User stories addressed

- User story 15: terminal instances stay alive when tab is hidden
- User story 18: WebSocket exponential backoff reconnection preserved
- User story 26: connection status overlays work with new session router

---

## Issue 11: PTY-first resize

### What to build

Replace the current resize flow (fit terminal first, then send RPC) with a PTY-first approach that prevents output clobbering during resize.

**New flow:**
1. Container resize fires (via ResizeObserver, debounced at 100ms)
2. Call `fitAddon.proposeDimensions()` to calculate desired cols/rows **without applying them** to the terminal
3. Send the new dimensions to the backend via `router.resize(terminalId, cols, rows)` (or the terminal service resize RPC)
4. Backend resizes the PTY and the headless terminal
5. Only after the backend confirms, call `terminal.resize(cols, rows)` on the frontend ghostty-web terminal

**Coalescing:** Serialize in-flight resize requests. If a resize is in-flight and another resize event arrives, set a pending flag and coalesce. When the in-flight resize completes, send the latest pending dimensions.

Refer to PRD section "Module 5: Frontend: PTY-First Resize Handler" and Mux's resize flow in `TerminalView.tsx` (lines 739-842) for the reference pattern.

### Acceptance criteria

- [ ] `fitAddon.proposeDimensions()` is used to calculate dimensions without applying
- [ ] Resize RPC is sent to backend before `terminal.resize()` is called on frontend
- [ ] Frontend terminal is resized only after backend confirmation
- [ ] Rapid resize events during panel drag are coalesced (one in-flight at a time)
- [ ] Headless terminal on the backend is resized in sync (from Issue 7)
- [ ] No visible tearing or stale-dimension output during panel drag resize
- [ ] Tests: proposeDimensions is called before terminal.resize
- [ ] Tests: backend resize RPC is sent before frontend resize
- [ ] Tests: rapid sequential resize events are coalesced into fewer RPC calls
- [ ] Tests: terminal dimensions match the last proposed dimensions after coalescing

### TDD approach

1. Test that `proposeDimensions()` returns `{ cols, rows }` without mutating `terminal.cols`/`terminal.rows`
2. Test that the resize handler sends an RPC before calling `terminal.resize()`
3. Test that two rapid resize events result in only one in-flight RPC, with the second coalesced
4. Test that after coalesced resize completes, the terminal has the latest dimensions

### Blocked by

- Blocked by "ghostty-web FitAddon and basic resize"
- Blocked by "Backend: Headless terminal state manager"
- Blocked by "Frontend: Terminal Router context and integration"

### User stories addressed

- User story 7: terminal resize sent to backend first, frontend resizes after confirmation

---

## Issue 12: Cleanup: Remove xterm.js and ring buffer

### What to build

Final cleanup to remove all vestiges of the xterm.js stack and the ring buffer, update e2e tests, and verify builds pass.

**Remove from `apps/web/package.json`:**
- All `@xterm/*` packages (should already be gone from Issue 1, verify)

**Remove from `packages/terminal`:**
- `RingBuffer` class (`src/lib/ring-buffer.ts`)
- `ring-buffer.test.ts` test file
- `TerminalBufferState` interface and `bufferStates` map from terminal manager
- Any remaining ring buffer references (e.g., `RING_BUFFER_CAPACITY` constant)

**Remove from `apps/web`:**
- `useTerminalWebSocket` hook (replaced by Terminal Session Router in Issues 9-10)
- Any remaining xterm.js imports or references

**Remove from `vite.config.ts`:**
- `patchXtermEnumPlugin` (should already be gone from Issue 1, verify)

**Update e2e tests:**
- `terminal-interaction.spec.ts`: update selectors for ghostty-web's DOM structure (canvas element, contenteditable input)

**Verify:**
- `bun run check` passes (typecheck + format + tests)
- Dev build serves correctly with ghostty-web WASM
- Production build includes `ghostty-vt.wasm` and terminals work

### Acceptance criteria

- [ ] No `@xterm/*` imports or dependencies anywhere in the codebase (grep verification)
- [ ] `RingBuffer` class and its test file are deleted
- [ ] `TerminalBufferState` and `bufferStates` references removed from terminal manager
- [ ] `useTerminalWebSocket` hook is deleted
- [ ] `patchXtermEnumPlugin` is deleted from vite.config.ts
- [ ] e2e `terminal-interaction.spec.ts` passes with ghostty-web DOM selectors
- [ ] `bun run check` passes (typecheck + format fix + tests)
- [ ] Dev build starts and terminals render correctly
- [ ] Production build completes and terminals render correctly
- [ ] Tests: grep-based lint check confirms no stale @xterm imports
- [ ] Tests: build verification passes in both dev and production modes
- [ ] Tests: e2e terminal interaction test creates a terminal, sends a command, and verifies output

### TDD approach

1. Test (grep/lint): no files in `apps/web/src` contain `@xterm` imports
2. Test (grep/lint): no files in `packages/terminal/src` reference `RingBuffer`
3. Test (build): `bun run check` exits with code 0
4. Test (e2e): terminal interaction spec passes with updated selectors

### Blocked by

- Blocked by all previous issues (#1 through #11)

### User stories addressed

- User story 16: fullscreen portal behavior preserved (verified e2e)
- User story 19: dev server terminal pane works with new engine (verified e2e)
- User story 21: xterm.js and all addons completely removed from dependency tree
