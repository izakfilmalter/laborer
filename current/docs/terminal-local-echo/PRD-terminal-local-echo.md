## Problem Statement

Laborer's terminal renderer waits for the PTY to echo each keystroke before displaying it. Process scheduling, a busy agent, or backpressure in the terminal data channel can make that delay perceptible and cause interactive typing to feel less responsive.

The delay is most noticeable while editing commands, navigating with arrows, or using tab completion. The renderer can hide it without changing terminal correctness by predicting ordinary input until the PTY confirms the output.

This is a general terminal-rendering concern rather than a workspace-lifecycle concern. The prediction layer therefore responds to measured echo latency instead of assuming a particular terminal type.

## Solution

Port VS Code's `TypeAheadAddon` — a client-side local echo prediction system — into laborer's terminal renderer. When a user types a character, the addon immediately writes a predicted version of that character to xterm.js (rendered with a dim style to indicate it's unconfirmed). When the server's echo arrives, the addon reconciles: if the prediction was correct, the dim styling is replaced with the real output; if the prediction was wrong, it is rolled back and the real output is shown.

The addon uses adaptive latency detection to enable itself whenever median echo latency exceeds a configurable threshold. It stays dormant on responsive terminals and activates only when prediction would improve typing.

The addon is adapted from VS Code's MIT-licensed `terminalTypeAheadAddon.ts` (~1575 lines), with VS Code-specific framework dependencies (DI, configuration service, telemetry, Disposable/Emitter) replaced by minimal inline equivalents. The core prediction logic — covering character prediction, backspace, cursor movement, word boundary navigation, line wrapping, newline, and reconciliation — is preserved as-is.

## User Stories

1. As a developer, I want typed characters to appear immediately when terminal echo is delayed, so that interactive typing remains responsive.

2. As a developer, I want predicted characters to be visually distinguishable from confirmed characters (rendered dim), so that I know which characters haven't been confirmed by the server yet.

3. As a developer, I want incorrect predictions to be automatically rolled back when the server sends different output, so that I always see the correct terminal state.

4. As a developer, I want backspace to work predictively (immediately removes the previous character), so that correcting typos feels instant.

5. As a developer, I want arrow key movement (left, right) to be predicted, so that navigating within a command line feels instant.

6. As a developer, I want word-boundary movement (Ctrl+Left, Ctrl+Right, Alt+B, Alt+F) to be predicted, so that jumping between words in a command feels instant.

7. As a developer, I want Enter to be predicted (cursor moves to the next line), so that submitting commands doesn't feel delayed.

8. As a developer, I want line-wrapping at the terminal edge to be handled correctly when typing long commands, so that predictions don't break when the cursor wraps to the next line.

9. As a developer, I want the prediction system to automatically detect when I'm running a full-screen program (vim, vi, nano, tmux) and disable itself, so that predictions don't interfere with programs that handle their own input.

10. As a developer, I want the prediction system to automatically enable itself based on latency, so that I get local echo only when it helps.

11. As a developer, I want predictions to be automatically cleared after a timeout if the server doesn't confirm them, so that stale predictions don't linger on screen.

12. As a developer, I want unrecognized input (control sequences, special keys not handled by the predictor) to immediately stop prediction, so that the addon doesn't produce incorrect output for complex terminal interactions.

13. As a developer, I want terminal resizes to be handled gracefully (predictions cleared and re-evaluated after resize), so that the cursor position tracking stays correct.

14. As a developer, I want the prediction system to work correctly after a terminal reconnection/replay, so that the addon doesn't show stale predictions from a previous session.

15. As a developer, I want the prediction system to handle partial server responses correctly (server sends data in chunks), so that predictions aren't incorrectly rejected when the server response arrives in multiple pieces.

16. As a developer, I want the prediction system to handle shell-specific quirks (zsh backspace behavior, bash line wrapping), so that predictions are accurate across different shells.

17. As a developer, I want cursor flicker to be prevented during prediction display and reconciliation, so that the terminal looks smooth while typing.

18. As a developer, I want the prediction system to track accuracy statistics and disable itself if prediction accuracy drops too low, so that it doesn't make things worse for terminal contexts where prediction is unreliable.

## 'Polishing' Requirements

1. Verify that predicted characters are visually distinguishable but not distracting — dim styling should be subtle enough that fast typists don't notice the transition from predicted to confirmed text.

2. Verify that the addon produces no visual glitches when the server response arrives in the same frame as the prediction (zero-latency path — predictions should be invisible).

3. Verify that the addon produces no visual artifacts when disabled (program exclusion, low latency) — no orphaned dim characters, no cursor position drift.

4. Verify that rapid typing (>10 characters per second) produces smooth prediction display with no flickering or stacking of rollback/rollforward sequences.

5. Verify that the addon doesn't interfere with existing terminal features: web links detection, image rendering (iTerm2/Sixel), Unicode character width, WebGL rendering.

6. Verify that the addon adds no measurable overhead to responsive terminals where it remains dormant (no wasted computation in the `beforeServerInput` path when no predictions are pending).

7. Verify that prediction accuracy is >90% for basic typing scenarios (printable characters, backspace, Enter) in bash and zsh shells.

8. Verify that the timeout-based prediction clearing doesn't trigger during normal high-latency typing (the timeout should be calibrated to the observed latency, not a fixed value).

9. Verify that the addon handles the transition between normal buffer and alternate buffer correctly (e.g., entering and exiting vim or less).

## Implementation Decisions

### Addon Architecture

The addon is a single file adapted from VS Code's `terminalTypeAheadAddon.ts` (MIT-licensed). The file retains the Microsoft MIT license header with an added note that it has been adapted for laborer. The core prediction logic is preserved as-is — the adaptation is limited to replacing VS Code framework dependencies with minimal inline equivalents.

### VS Code Dependency Replacements

- **`Disposable` / `Emitter` / `toDisposable`**: Replaced by minimal inline classes (~40 lines) that match VS Code's API surface (`_register`, `dispose`, `fire`, `event`). This keeps the addon's internal structure nearly identical to VS Code's, making future cherry-picks straightforward.
- **`@debounce` decorator**: Replaced by wrapping methods in a debounce utility during construction, since the project's tsconfig does not enable `experimentalDecorators`.
- **`IConfigurationService`**: Replaced by a plain config object passed to the constructor with hardcoded defaults: `{ latencyThreshold: 30, style: 'dim', excludePrograms: ['vim', 'vi', 'nano', 'tmux'] }`.
- **`ITelemetryService`**: Removed entirely — no telemetry collection.
- **`ITerminalProcessManager.onBeforeProcessData`**: Replaced by an `onBeforeProcessData` callback added to the `useTerminalMessagePort` hook (see below).
- **`Color.fromHex`**: Replaced by a simple inline hex-to-RGB parser (~5 lines) for the custom color style code path.
- **`escapeRegExpCharacters`**: Replaced by inline utility.
- **`isNumber` / `SingleOrMany`**: Replaced by inline type checks.
- **`disposableTimeout`**: Replaced by `setTimeout` + `clearTimeout` wrapped in the inline `Disposable` pattern.

### Data Interception (`onBeforeProcessData`)

Following VS Code's pattern, server PTY output is intercepted before reaching xterm.js. The `useTerminalMessagePort` hook gains a new optional `onBeforeProcessData` callback. When set, the hook creates a mutable `{ data: string }` event object before each `onData` call, passes it through `onBeforeProcessData`, and uses the (possibly mutated) `event.data` for the `onData` callback.

In `terminal-pane.tsx`, the `TerminalPaneMessagePort` component:
1. Creates the `TypeAheadAddon` instance
2. Loads it into xterm via `terminal.loadAddon(addon)`
3. Passes the addon's `beforeServerInput` method as the `onBeforeProcessData` callback to `useTerminalMessagePort`

The addon registers its `terminal.onData` listener internally during `activate()` to intercept user keystrokes, matching VS Code's wiring.

### xterm.js Internal Access

The addon accesses `(terminal as any)._core._inputHandler._curAttrData` to read current cursor attributes for accurate rollback of styled text. This matches VS Code's approach on the same xterm.js v6.x line. Both laborer (`@xterm/xterm ^6.0.0`) and VS Code (`@xterm/xterm ^6.1.0-beta.168`) use xterm 6.x, so the internal structure is compatible.

### Adaptive Enable/Disable

The addon uses VS Code's `PredictionStats` system — a circular buffer of 24 `(latency, correct)` tuples. Predictions are enabled when:
- Sample size > 5 AND accuracy > 30% AND median latency >= threshold (30ms)

Predictions are disabled when:
- Median latency drops below `threshold * 0.5` (15ms)

Prediction is also disabled when the terminal title matches the exclude regex (`/\b(vim|vi|nano|tmux)\b/i`).

This means the addon is completely dormant while echo is responsive and auto-activates when measured latency crosses the threshold, with no terminal-type-specific logic needed.

### Prediction Safety Mechanisms

- **Timeout clearing**: If predictions haven't been confirmed within `max(500ms, maxObservedLatency * 1.5)`, all predictions are rolled back. Prevents stale predictions on connection drops.
- **Hard boundaries**: Unrecognized input (control sequences, special keys) immediately stops all prediction. Prevents incorrect output for complex terminal interactions.
- **Generation system**: Predictions are grouped into generations separated by boundaries. Predictions in a new generation are not visually applied until the boundary prediction is confirmed. This prevents showing predictions in uncertain contexts (e.g., at the prompt start where we don't know if backspace is valid).
- **Tentative boundaries**: Predictions at the left edge of known user input (near the prompt) are wrapped as tentative — matched against server output but not visually shown until confirmed.

### Replay Handling

When a terminal replay starts (`handleReplayStart`), `addon.reset()` is called to clear per-line state. The replay data flowing through `beforeServerInput` naturally clears the prediction timeline since replay data won't match any pending predictions.

### File Location

Single file: `apps/web/src/lib/typeahead-addon.ts`. The addon is renderer-side code, tightly coupled to xterm.js and only used by `terminal-pane.tsx`.

### Configuration

Hardcoded defaults with no user-facing settings:
- Latency threshold: 30ms (adaptive stats handle enable/disable)
- Style: `'dim'` (predicted text rendered with dim attribute)
- Exclude programs: `['vim', 'vi', 'nano', 'tmux']`

User-facing settings can be added in a future iteration if needed.

## Testing Decisions

Good tests for this addon verify external behavior through the prediction interface, not internal implementation details like cursor position tracking or style sequence generation.

### Modules to test

1. **Prediction classes and PredictionTimeline** — Port VS Code's ~551 lines of tests from `terminalTypeAhead.test.ts`. These test the core prediction logic: character prediction/matching/rollback/rollforward, backspace prediction, cursor movement, newline, line wrapping, the timeline's `beforeServerInput` reconciliation, generation boundaries, and tentative boundaries. The tests use mock `Terminal` and `IBuffer` objects and exercise the addon through its public `_onUserData` and `_onBeforeProcessData` methods. Adapt VS Code test helpers (mock Disposable, Emitter, Terminal) to vitest.

2. **`useTerminalMessagePort` onBeforeProcessData integration** — Verify that the new `onBeforeProcessData` callback is called with a mutable event object before `onData`, and that mutated data is passed through correctly. Use existing test patterns for the MessagePort hook.

### Prior art

The existing terminal-related tests in `apps/web/test/` (e.g., `workspace-card-layout.test.tsx`) demonstrate the component testing patterns.

## Out of Scope

- **User-facing settings UI**: No settings modal entries for latency threshold, style, or exclude programs. Hardcoded defaults are sufficient for v1.
- **Server-side prediction**: All prediction happens in the renderer. No server-side changes to the terminal data channel protocol.
- **Alternative terminal transport**: The addon works within the existing PTY data channel. No protocol changes.
- **Custom prediction styles beyond VS Code's set**: The addon supports VS Code's built-in styles (bold, dim, italic, underlined, inverted, hex color) but we only use dim. No UI for choosing styles.
- **Per-terminal prediction toggle**: No way to manually enable/disable prediction for a specific terminal. The adaptive system handles this automatically.

## Further Notes

- **VS Code source reference**: The full addon source is at `.reference/vscode/src/vs/workbench/contrib/terminalContrib/typeAhead/browser/terminalTypeAheadAddon.ts` (~1575 lines). The test file is at `.reference/vscode/src/vs/workbench/contrib/terminalContrib/typeAhead/test/browser/terminalTypeAhead.test.ts` (~551 lines).

- **License**: The VS Code addon is MIT-licensed. The adapted file retains the Microsoft MIT license header with an added note indicating adaptation for laborer.

- **xterm.js version compatibility**: Both laborer (`@xterm/xterm ^6.0.0`) and VS Code (`@xterm/xterm ^6.1.0-beta.168`) use xterm 6.x. The internal `_core._inputHandler._curAttrData` API is stable across this range. If xterm changes internals in a major version, the addon's internal access points will need updating.

- **Future improvements**: If user demand warrants it, the hardcoded configuration can be promoted to the app settings modal. The adaptive stats system could also be extended to report latency metrics in the UI (e.g., a latency indicator in the terminal tab).

- **Prediction coverage**: The addon predicts printable ASCII characters (32-126), backspace (127), Enter (\r), cursor movement (CSI D/C, with/without modifier for word movement), and Alt+B/Alt+F (Emacs word movement). All other input creates a hard boundary that stops prediction. This covers the vast majority of interactive terminal typing.
