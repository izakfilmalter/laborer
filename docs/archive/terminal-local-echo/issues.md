# Terminal Local Echo — Issues

Parent PRD: [PRD-terminal-local-echo.md](./PRD-terminal-local-echo.md)

## Issue 1: Core typeahead addon — port prediction engine from VS Code

Status: TODO

### What to build

Port VS Code's `terminalTypeAheadAddon.ts` (~1575 lines) into `apps/web/src/lib/typeahead-addon.ts`. The file is a self-contained xterm.js addon implementing client-side local echo prediction. The adaptation replaces VS Code-specific framework dependencies with minimal inline equivalents while preserving the core prediction logic as-is.

Specific adaptations required:

- **`Disposable` + `Emitter` + `toDisposable`**: Write minimal inline classes (~40 lines) matching VS Code's API surface (`_register`, `dispose`, `fire`, `event`). Keep the addon's internal structure identical for easy future cherry-picks.
- **`@debounce` decorator**: Replace with wrapper functions applied during construction (project tsconfig does not enable `experimentalDecorators`).
- **`IConfigurationService`**: Replace with a plain config object passed to the constructor. Hardcode defaults: `{ latencyThreshold: 30, style: 'dim', excludePrograms: ['vim', 'vi', 'nano', 'tmux'] }`.
- **`ITelemetryService`**: Remove entirely — no telemetry.
- **`ITerminalProcessManager`**: Replace with a simple interface exposing only `onBeforeProcessData` (the single event the addon hooks into). The addon receives this via constructor instead of VS Code's DI.
- **`Color.fromHex`**: Replace with inline hex-to-RGB parser (~5 lines).
- **`escapeRegExpCharacters`**: Replace with inline utility.
- **`isNumber` / `SingleOrMany`**: Replace with inline type checks.
- **`disposableTimeout`**: Replace with `setTimeout` + `clearTimeout` wrapped in inline `Disposable`.

The file retains the Microsoft MIT license header with an added note indicating adaptation for laborer.

All prediction classes (`CharacterPrediction`, `BackspacePrediction`, `NewlinePrediction`, `LinewrapPrediction`, `CursorMovePrediction`, `HardBoundary`, `TentativeBoundary`), `StringReader`, `Cursor`, `PredictionTimeline`, `PredictionStats`, `TypeAheadStyle`, and `TypeAheadAddon` are preserved with their existing logic.

The addon accesses xterm internals via `(terminal as any)._core._inputHandler._curAttrData` — this is preserved as-is, matching VS Code's approach on xterm 6.x.

### Acceptance criteria

- [ ] `apps/web/src/lib/typeahead-addon.ts` exists and exports `TypeAheadAddon` implementing `ITerminalAddon` from `@xterm/xterm`
- [ ] No imports from VS Code namespaces (`vs/base/`, `vs/platform/`, `vs/workbench/`)
- [ ] `TypeAheadAddon` constructor accepts a process manager interface (with `onBeforeProcessData`) and a config object (not VS Code DI services)
- [ ] All prediction classes, `StringReader`, `Cursor`, `PredictionTimeline`, `PredictionStats`, `TypeAheadStyle` are present and functional
- [ ] `PredictionStats`, `PredictionTimeline`, `IPrediction`, `CharPredictState` are exported (needed by tests)
- [ ] Typecheck passes (`tsc --noEmit` for `apps/web`)
- [ ] Format passes (`bun run format`)
- [ ] File includes Microsoft MIT license header + adaptation note

### Blocked by

None — can start immediately.

### User stories addressed

- User story 1 (typed characters appear immediately)
- User story 2 (predicted characters visually distinguishable)
- User story 3 (incorrect predictions rolled back)
- User story 4 (backspace works predictively)
- User story 5 (arrow key movement predicted)
- User story 6 (word-boundary movement predicted)
- User story 7 (Enter predicted)
- User story 8 (line-wrapping handled)
- User story 9 (full-screen program detection)
- User story 10 (adaptive enable/disable)
- User story 11 (timeout clearing)
- User story 12 (unrecognized input stops prediction)
- User story 15 (partial server responses)
- User story 16 (shell-specific quirks)
- User story 17 (cursor flicker prevention)
- User story 18 (accuracy stats)

---

## Issue 2: Port VS Code typeahead tests

Status: TODO

### What to build

Port VS Code's `terminalTypeAhead.test.ts` (~551 lines) into `apps/web/test/typeahead-addon.test.ts`. Adapt VS Code test infrastructure to vitest while preserving all test cases and their assertions.

Specific adaptations required:

- **`suite` / `test` / `setup`**: Replace with vitest `describe` / `it` / `beforeEach`.
- **`assert`**: Replace with vitest `expect` (or keep Node `assert` — both work in vitest).
- **`sinon` stubs and fake timers**: Replace with `vi.fn()` and `vi.useFakeTimers()`.
- **`Emitter`**: Use the inline `Emitter` from the addon file (export it for tests).
- **`TestConfigurationService`**: Replace with a plain config object matching the addon's constructor signature.
- **`ITerminalProcessManager` mock**: Replace with a simple object containing an `onBeforeProcessData` event.
- **`ITelemetryService` mock**: Remove — addon no longer has telemetry.
- **`ensureNoDisposablesAreLeakedInTestSuite`**: Replace with vitest `afterEach` cleanup.
- **`TestTypeAheadAddon` subclass**: Port the test helper that exposes internal state for assertions.
- **Mock `Terminal` and `IBuffer`**: Port the mock terminal infrastructure that creates fake xterm buffers.

All test cases from the VS Code suite should be preserved:

- `PredictionStats` tests (accuracy, circular buffer, latency stats)
- `timeline` tests (character prediction, backspace, cursor movement, newline, line wrap, generation boundaries, rollback on failure, tentative boundaries, partial matching, zsh quirks)

### Acceptance criteria

- [ ] `apps/web/test/typeahead-addon.test.ts` exists with all VS Code test cases ported
- [ ] All tests pass (`bun test` in `apps/web`)
- [ ] Tests use vitest primitives (`describe`, `it`, `expect`, `vi.fn()`, `vi.useFakeTimers()`)
- [ ] No imports from VS Code namespaces
- [ ] Format passes (`bun run format`)

### Blocked by

- Blocked by "Issue 1: Core typeahead addon — port prediction engine from VS Code"

### User stories addressed

- (Testing coverage for all user stories 1-18)

---

## Issue 3: Hook integration — add onBeforeProcessData to useTerminalMessagePort

Status: TODO

### What to build

Add an `onBeforeProcessData` callback to the `useTerminalMessagePort` hook. This follows VS Code's `ITerminalProcessManager.onBeforeProcessData` pattern where PTY output data can be intercepted and transformed before reaching xterm.js.

In `apps/web/src/hooks/use-terminal-messageport.ts`:

1. Add a new `onBeforeProcessData` parameter to the hook's options/props — a callback with signature `(event: { data: string }) => void`.
2. In `handleMessage`, before each `onDataRef.current(data)` call (for both ArrayBuffer and string paths), create a mutable `{ data }` event object, call `onBeforeProcessData(event)` if set, then use `event.data` for the `onData` call and the `maybeAck` char count.
3. Also apply the transform to `screenState` control messages (which also pipe data to `onData`).
4. Do NOT apply the transform to replay events — replay data should bypass the prediction system (replay frames are historical, not live PTY output).

The `onBeforeProcessData` callback is optional. When not provided, behavior is identical to current (no transform, no overhead).

### Acceptance criteria

- [ ] `useTerminalMessagePort` accepts an optional `onBeforeProcessData` callback
- [ ] Raw PTY string data passes through `onBeforeProcessData` before `onData`
- [ ] ArrayBuffer data passes through `onBeforeProcessData` (after decode) before `onData`
- [ ] Screen state data passes through `onBeforeProcessData` before `onData`
- [ ] Replay data does NOT pass through `onBeforeProcessData`
- [ ] When `onBeforeProcessData` is not provided, behavior is identical to current
- [ ] `maybeAck` uses the (possibly transformed) data length for flow control
- [ ] Typecheck passes
- [ ] Format passes

### Blocked by

None — can start immediately. (Can be done in parallel with Issue 1.)

### User stories addressed

- (Infrastructure for user stories 1, 3, 15)

---

## Issue 4: Wire addon into terminal-pane — end-to-end activation

Status: TODO

### What to build

Connect the `TypeAheadAddon` to the terminal renderer in `apps/web/src/panes/terminal-pane.tsx`, completing the end-to-end local echo prediction pipeline.

In `TerminalPaneRenderer`:

1. Import `TypeAheadAddon` from `@/lib/typeahead-addon`.
2. Create a process manager adapter object that exposes an `onBeforeProcessData` event (matching the interface the addon expects). This adapter bridges between the `useTerminalMessagePort` hook's `onBeforeProcessData` callback and the addon's event subscription.
3. Create the `TypeAheadAddon` instance with the process manager adapter and hardcoded config: `{ latencyThreshold: 30, style: 'dim', excludePrograms: ['vim', 'vi', 'nano', 'tmux'] }`.
4. Load the addon via `terminal.loadAddon(addon)` during terminal initialization (after `terminal.open()`, after other addons are loaded).
5. Pass the process manager adapter's fire function as the `onBeforeProcessData` callback to `useTerminalMessagePort`.
6. In `handleReplayStart`, call `addon.reset()` before replaying frames — matching VS Code's `onProcessReady` pattern.
7. Dispose the addon when the terminal is disposed (in the useEffect cleanup).

The addon's `activate()` method registers `terminal.onData` internally (for keystroke interception), so no additional wiring is needed for the input path.

### Acceptance criteria

- [ ] `TypeAheadAddon` is loaded into every terminal instance
- [ ] Keystroke predictions appear immediately in the terminal (dim styling) when latency exceeds 30ms
- [ ] Server echo reconciles predictions correctly (dim text replaced with real output)
- [ ] Incorrect predictions are rolled back cleanly
- [ ] Predictions are cleared on terminal replay/reconnection
- [ ] Addon is disposed when terminal unmounts
- [ ] No visual glitches for responsive terminals (addon remains dormant below the latency threshold)
- [ ] No visual glitches during rapid typing
- [ ] Typecheck passes
- [ ] Format passes
- [ ] Existing terminal tests still pass

### Blocked by

- Blocked by "Issue 1: Core typeahead addon — port prediction engine from VS Code"
- Blocked by "Issue 3: Hook integration — add onBeforeProcessData to useTerminalMessagePort"

### User stories addressed

- User story 1 (typed characters appear immediately)
- User story 2 (predicted characters visually distinguishable)
- User story 10 (adaptive enable/disable based on latency)
- User story 13 (terminal resizes handled)
- User story 14 (replay/reconnection handled)
