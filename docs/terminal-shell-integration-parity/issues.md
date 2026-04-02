# Issues: Terminal Shell Integration & Recovery Parity with VS Code

**PRD:** [PRD.md](./PRD.md)

## Summary

| # | Title | Blocked by | Status |
|---|-------|------------|--------|
| 1 | Positional metadata on commands (OSC 633;A + 633;C) | None | Done |
| 2 | Complete PromptInputModel | 1 | Done |
| 3 | FinalTerm 133 command detection fallback | 1 | Done |
| 4 | OSC 633;F/G/H/I (continuation + right prompt) | 1 | Done |
| 5 | Capability store + CwdDetection | None | Done |
| 6 | BufferMarkDetection + gutter UI | 5 | Ready |
| 7 | ShellEnvDetection + indicator | 5 | Ready |
| 8 | PromptTypeDetection + badge | 5 | Ready |
| 9 | Renderer shell integration addon + command deserialization | 1 | Done |
| 10 | Replay input guard | None | Done |
| 11 | rawReviveBuffer optimization | None | Done |

**Dependency graph:**

```
Slice 1 (positional metadata) ──┬── Slice 2 (prompt model)
                                ├── Slice 3 (FinalTerm fallback)
                                ├── Slice 4 (continuation/right prompt)
                                └── Slice 9 (renderer addon)

Slice 5 (capability store + cwd) ──┬── Slice 6 (buffer marks)
                                    ├── Slice 7 (shell env)
                                    └── Slice 8 (prompt type)

Slice 10 (replay guard) ── independent
Slice 11 (rawReviveBuffer) ── independent
```

---

## Issue 1: Positional metadata on commands (OSC 633;A + 633;C)

### What to build

Add OSC 633;A (prompt start) and OSC 633;C (command executed) handlers to the headless terminal's shell integration, and use xterm markers to track positional metadata for each command. Currently, serialized commands have the correct type shape (with `startLine`, `promptStartLine`, `endLine`, `executedLine`, `executedX`, `startX`, `commandStartLineContent` fields) but these fields are never populated during live command tracking.

End-to-end behavior:
1. The headless terminal receives OSC 633;A — it registers an xterm marker at the current cursor line and stores it as the prompt start position for the next command.
2. The headless terminal receives OSC 633;B — it registers a command start marker, reads `buffer.active.cursorX` for `startX`, and captures the line content at the cursor for `commandStartLineContent`.
3. The headless terminal receives OSC 633;C — it registers an executed marker and reads `buffer.active.cursorX` for `executedX`.
4. The headless terminal receives OSC 633;D — it registers an end marker. The completed command is pushed with all four line numbers (`promptStartLine`, `startLine`, `executedLine`, `endLine`) and both X positions (`startX`, `executedX`) plus `commandStartLineContent`.
5. The serialized state flows through persistence and the data channel to the renderer with all positional fields populated.

This is the foundation slice — issues 2, 3, 4, and 9 all depend on the marker infrastructure built here.

### Acceptance criteria

- [x] OSC 633;A handler registers a prompt start marker via `terminal.registerMarker()` and stores the marker's line number
- [x] OSC 633;B handler registers a command start marker, captures `startX` from `buffer.active.cursorX`, and captures `commandStartLineContent` from the buffer line at the cursor
- [x] OSC 633;C handler registers an executed marker and captures `executedX` from `buffer.active.cursorX`
- [x] OSC 633;D handler registers an end marker; the completed command includes `promptStartLine`, `startLine`, `executedLine`, `endLine`, `executedX`, `startX`, and `commandStartLineContent`
- [x] `getCommandDetectionState()` returns commands with all positional fields populated
- [x] Partial/in-flight commands include `promptStartLine`, `startLine`, and `startX` (but not `endLine`, `executedLine`, `executedX`)
- [x] Positional metadata survives serialization roundtrip through `terminal-session-persistence`
- [x] Positional metadata flows through the data channel replay event to the renderer
- [x] Tests in `headless-terminal.test.ts` verify positional metadata for a complete command lifecycle (A -> B -> E -> C -> D)
- [x] Tests in `terminal-session-persistence.test.ts` verify positional metadata persists in serialized state
- [x] Tests in `terminal-data-channel.test.ts` verify positional metadata appears in replay events

### Blocked by

None — can start immediately.

### User stories addressed

- User story 1: Command gutter decorations at correct scrollback positions
- User story 2: Click on command gutter marker to see command info
- User story 12: Each serialized command includes positional metadata
- User story 13: `commandStartLineContent` captured for each command

---

## Issue 2: Complete PromptInputModel

### What to build

Expand the `PromptInputModel` serialization to match VS Code's full `ISerializedPromptInputModel` interface. Currently, we track `value`, `cursorIndex`, `lastPromptLine`, and `continuationPrompt`. VS Code additionally tracks `commandStartX`, `lastUserInput`, and `ghostTextIndex`.

End-to-end behavior:
1. When OSC 633;B fires (command start), `commandStartX` is captured from `buffer.active.cursorX` and stored in the prompt input model.
2. When OSC 633;C fires (command executed), the current prompt input `value` is saved as `lastUserInput`.
3. `ghostTextIndex` defaults to `-1` (no ghost text) — future inline suggestion features will set this.
4. `serializePromptInputModel()` includes all three new fields.
5. The serialized prompt input model flows through persistence (version bumped to 3) and the data channel to the renderer.

### Acceptance criteria

- [x] `PromptInputModel` internal state includes `commandStartX`, `lastUserInput`, and `ghostTextIndex`
- [x] `commandStartX` is set from `buffer.active.cursorX` when OSC 633;B fires
- [x] `lastUserInput` is set from the current prompt input value when OSC 633;C fires
- [x] `ghostTextIndex` defaults to `-1`
- [x] `SerializedPromptInputModel` type includes `commandStartX: number`, `lastUserInput: string`, and `ghostTextIndex: number`
- [x] Serialized state version bumped from 2 to 3
- [x] `loadPersistedState()` validates `version === 3`
- [x] Tests verify the new fields serialize and restore correctly
- [x] Tests verify `commandStartX` is captured at 633;B and `lastUserInput` at 633;C

### Blocked by

- Blocked by "Issue 1: Positional metadata on commands" — needs the 633;C handler for `commandStartX` capture timing and `lastUserInput` save point.

### User stories addressed

- User story 18: Prompt input model includes ghost text positioning after recovery
- User story 19: Prompt input model includes command start column and last user input after recovery

---

## Issue 3: FinalTerm 133 command detection fallback

### What to build

Add OSC 133;B (command start) and OSC 133;D (command finished) handling as a command detection fallback for shells that emit FinalTerm sequences but not VS Code OSC 633 sequences. This covers shells like powerlevel10k that may only emit 133 sequences.

End-to-end behavior:
1. When only OSC 133 sequences are seen (no 633), the headless terminal uses 133;A as prompt start, 133;B as command start, 133;C as command executed, and 133;D as command finished — creating the same command lifecycle tracked by 633.
2. Once any OSC 633 sequence is seen, the shell integration status becomes "VSCode" and 133;B/D no longer create commands (the 633 handlers take over). 133;A and 133;C continue to fire prompt state callbacks as they do today.
3. Commands detected via FinalTerm fallback have `commandLineConfidence: 'low'` and `isTrusted: false` since FinalTerm does not include the command line text or nonce.
4. Positional metadata (markers) is tracked the same way as for 633 commands.
5. The fallback commands serialize and flow through persistence and the data channel identically to 633-detected commands.

### Acceptance criteria

- [x] OSC 133;B handler creates a command start (with marker) when no 633 command detection has been seen
- [x] OSC 133;D handler finalizes the current command (with exit code from args, end marker) when no 633 command detection has been seen
- [x] FinalTerm-detected commands have `commandLineConfidence: 'low'`, `isTrusted: false`, and empty `command` string
- [x] FinalTerm-detected commands include positional metadata (`startLine`, `endLine`, etc.) from markers
- [x] Once any OSC 633 sequence is seen, 133;B and 133;D stop creating commands (priority scheme)
- [x] 133;A and 133;C continue to emit prompt state callbacks regardless of 633 presence (existing behavior preserved)
- [x] A `shellIntegrationStatus` field (or equivalent) tracks whether 633 sequences have been seen
- [x] Tests verify pure FinalTerm command detection (133;A -> 133;B -> 133;C -> 133;D) produces a serialized command
- [x] Tests verify that 633 takes priority: after seeing a 633 sequence, 133;B/D are ignored for command detection
- [x] Tests verify FinalTerm commands serialize through persistence and appear in replay events

### Blocked by

- Blocked by "Issue 1: Positional metadata on commands" — reuses the marker infrastructure for positional metadata.

### User stories addressed

- User story 9: Command detection works as fallback with FinalTerm (OSC 133) sequences

---

## Issue 4: OSC 633;F/G/H/I (continuation + right prompt)

### What to build

Add handlers for OSC 633;F (continuation start), 633;G (continuation end), 633;H (right prompt start), and 633;I (right prompt end). These sequences are marked "UNFINALIZED" in VS Code but are actively handled. They enable tracking multi-line command input and right-aligned prompts.

End-to-end behavior:
1. When 633;F fires, the headless terminal sets an "in continuation" flag on the current command. This indicates the shell is rendering a continuation prompt for multi-line input.
2. When 633;G fires, the continuation flag is cleared.
3. When 633;H fires, the headless terminal records a right prompt start marker.
4. When 633;I fires, the right prompt end is noted.
5. These are tracked internally for future UI consumption but do not change the serialized command shape. They provide context for prompt rendering and multi-line command boundary detection.

### Acceptance criteria

- [x] OSC 633;F handler sets a continuation state flag on the current command
- [x] OSC 633;G handler clears the continuation state flag
- [x] OSC 633;H handler records a right prompt start marker position
- [x] OSC 633;I handler clears the right prompt state
- [x] No changes to serialized command shape or persistence format
- [x] Tests verify continuation state toggles correctly across F/G sequences
- [x] Tests verify right prompt state toggles correctly across H/I sequences
- [x] Tests verify that F/G/H/I sequences do not interfere with the A/B/C/D command lifecycle

### Blocked by

- Blocked by "Issue 1: Positional metadata on commands" — reuses the marker infrastructure.

### User stories addressed

- User story 10: Multi-line commands tracked as single commands
- User story 11: Right-aligned prompt content tracked separately

---

## Issue 5: Capability store + CwdDetection

### What to build

Create a new capability store module and implement the first capability: `CwdDetection`. This is a full vertical slice that cuts through all layers — headless lib, new capability store, persistence serialization, data channel protocol, RPC lifecycle events, renderer hooks, and terminal UI.

End-to-end behavior:
1. A new `CapabilityStore` tracks capabilities per terminal in the headless terminal manager.
2. `CwdDetection` tracks cwd changes with a history of `{ cwd, line? }` entries. Fed by the existing OSC 633;P Cwd handler, plus new OSC 7 (SetCwd), OSC 9 (SetWindowsFriendlyCwd), and OSC 1337 CurrentDir handlers.
3. OSC 7 parses `file://` URIs. OSC 9 parses Windows-friendly paths. OSC 1337 CurrentDir parses the raw path value.
4. The capability store serializes into a new `capabilities` field on the replay event, alongside the existing `commands` field.
5. Live cwd changes flow through the terminal manager's lifecycle events (e.g., `ProcessChanged`) to the renderer.
6. The renderer's terminal sidebar list and/or tab bar displays the current cwd (last 2-3 path segments).
7. After recovery, the cwd display restores from the persisted capability state.

### Acceptance criteria

- [x] New `CapabilityStore` module with typed capability registration and serialization
- [x] `CwdDetection` capability tracks cwd changes with history entries
- [x] OSC 7 handler parses `file://` URIs and feeds CwdDetection
- [x] OSC 9 handler parses Windows-friendly cwd and feeds CwdDetection
- [x] OSC 1337 CurrentDir handler feeds CwdDetection
- [x] OSC 633;P Cwd (existing) also feeds CwdDetection
- [x] `SerializedReplayEvent` includes optional `capabilities` field with `SerializedCapabilityStore`
- [x] `SerializedCapabilityStore` includes `cwdDetection` with current cwd and history
- [ ] Live cwd changes emit through lifecycle events to the renderer
- [ ] Terminal sidebar list shows current cwd (truncated for long paths)
- [ ] Cwd display updates reactively when the shell changes directory
- [x] Cwd restores correctly from persisted capability state after recovery
- [x] Tests in `headless-terminal.test.ts` verify cwd detection from all four OSC sources
- [x] Tests in `terminal-session-persistence.test.ts` verify capability store serialization roundtrip
- [x] Tests in `terminal-data-channel.test.ts` verify capabilities flow through replay events

### Blocked by

None — can start immediately (independent of issues 1-4).

### User stories addressed

- User story 3: Terminal tab/header displays current working directory
- User story 4: Cwd display updates in real-time
- User story 5: Cwd detection works with OSC 7, OSC 9, OSC 1337, and OSC 633;P Cwd
- User story 23: Capability store serializable alongside command detection
- User story 24: Cwd display restores correctly after recovery

---

## Issue 6: BufferMarkDetection + gutter UI

### What to build

Add `BufferMarkDetection` capability to the capability store and build a renderer-side decoration addon that places gutter indicators at mark positions.

End-to-end behavior:
1. OSC 633 SetMark sequences (with optional Id and Hidden parameters) are parsed and stored as buffer marks in the capability store.
2. OSC 633;P Task property creates a buffer mark and disables command storage for task terminals.
3. OSC 1337 SetMark (iTerm) also creates buffer marks.
4. Buffer marks serialize with their line position, optional id, and hidden flag.
5. After recovery, marks restore from persisted state.
6. A new decoration addon in the renderer reads mark positions and renders gutter indicators using xterm's decoration API.

### Acceptance criteria

- [ ] `BufferMarkDetection` capability tracks marks as `{ line, id?, hidden? }` entries
- [ ] OSC 633 SetMark handler parses Id and Hidden parameters and creates marks
- [ ] OSC 633;P Task handler creates a mark and sets `disableCommandStorage`
- [ ] OSC 1337 SetMark handler creates marks
- [ ] Buffer marks serialize in `SerializedCapabilityStore.bufferMarks`
- [ ] Buffer marks restore from persisted state after recovery
- [ ] Renderer decoration addon places gutter indicators at mark line positions
- [ ] Hidden marks are tracked but not rendered
- [ ] Tests verify mark creation from all three OSC sources
- [ ] Tests verify mark serialization/restoration roundtrip
- [ ] Tests verify the decoration addon renders at correct positions

### Blocked by

- Blocked by "Issue 5: Capability store + CwdDetection" — uses the capability store infrastructure.

### User stories addressed

- User story 6: Terminal shows buffer marks in scrollback gutter
- User story 25: Buffer marks restore correctly after recovery

---

## Issue 7: ShellEnvDetection + indicator

### What to build

Add `ShellEnvDetection` capability to the capability store with nonce-verified trust, and add an active indicator in the terminal UI.

End-to-end behavior:
1. OSC 633 EnvJson sequences send the complete shell environment as JSON with a mandatory nonce. If the nonce matches, the env is trusted.
2. OSC 633 EnvSingleStart/EnvSingleEntry/EnvSingleEnd sequences send individual env vars in a transaction with optional nonce. EnvSingleDelete removes a var.
3. Trust is tracked per batch — if any operation in a batch is untrusted, the entire batch becomes untrusted (logical AND).
4. The env map and trust flag serialize in the capability store.
5. The renderer shows a small icon/dot indicating that shell env detection is active for a terminal.

### Acceptance criteria

- [ ] `ShellEnvDetection` capability tracks env vars as `Map<string, string>` with `isTrusted` flag
- [ ] OSC 633 EnvJson handler parses JSON env, verifies nonce, stores env with trust
- [ ] OSC 633 EnvSingleStart handler begins a transaction (with optional clear flag)
- [ ] OSC 633 EnvSingleEntry handler adds a key-value pair to the pending transaction
- [ ] OSC 633 EnvSingleEnd handler commits the transaction, fires change event
- [ ] OSC 633 EnvSingleDelete handler removes a single env var
- [ ] Trust uses logical AND across batch operations — any untrusted operation makes the batch untrusted
- [ ] Env serializes in `SerializedCapabilityStore.shellEnvDetection` as `{ env, isTrusted }`
- [ ] Renderer shows an active indicator when env detection is present
- [ ] Tests verify trusted and untrusted env detection via EnvJson
- [ ] Tests verify EnvSingle* transaction flow
- [ ] Tests verify trust propagation (AND logic)

### Blocked by

- Blocked by "Issue 5: Capability store + CwdDetection" — uses the capability store infrastructure.

### User stories addressed

- User story 7: Indicator showing env detection is active
- User story 23: Capability store serializable alongside command detection

---

## Issue 8: PromptTypeDetection + badge

### What to build

Add `PromptTypeDetection` capability to the capability store and display a badge in the terminal UI.

End-to-end behavior:
1. OSC 633;P PromptType property reports the prompt framework name (e.g., "p10k", "posh-git", "starship").
2. The prompt type string is stored in the capability store.
3. The prompt type serializes and restores via the capability store.
4. The renderer shows a small badge/label in the terminal header with the prompt type name. Only visible when prompt type detection is active.

### Acceptance criteria

- [ ] `PromptTypeDetection` capability stores the detected prompt type string
- [ ] OSC 633;P PromptType handler feeds the capability
- [ ] Prompt type serializes in `SerializedCapabilityStore.promptType`
- [ ] Prompt type restores from persisted state after recovery
- [ ] Renderer shows a badge with the prompt type name when detected
- [ ] Badge is hidden when no prompt type is detected
- [ ] Tests verify prompt type detection from OSC 633;P PromptType
- [ ] Tests verify serialization roundtrip

### Blocked by

- Blocked by "Issue 5: Capability store + CwdDetection" — uses the capability store infrastructure.

### User stories addressed

- User story 8: Prompt framework identification badge
- User story 23: Capability store serializable alongside command detection

---

## Issue 9: Renderer shell integration addon + command deserialization

### What to build

Create a shell integration addon for the renderer's xterm instance that deserializes recovered commands into live xterm markers and fires lifecycle events for UI consumers.

End-to-end behavior:
1. A new addon is loaded in the renderer xterm alongside existing addons (fit, WebGL, etc.).
2. After replay completes and `replayComplete` is received, the addon receives `ISerializedCommandDetectionCapability` from the replay event.
3. For each finished command (has `endLine`): register xterm markers at `startLine`, `promptStartLine`, `executedLine`, `endLine` using `xterm.registerMarker(line - (buffer.baseY + buffer.cursorY))`. Create a command object with `wasReplayed: true`. Fire `onCommandFinished`.
4. For the partial command (`endLine === undefined`): restore as the current in-flight command. Register markers at `startLine` and `promptStartLine`. Fire `onCommandStarted`.
5. Restore `isWindowsPty`, `hasRichCommandDetection`, and `promptInputModel` state.
6. After deserialization, the addon continues to process live OSC 633/133 sequences for new commands, so command detection remains live.
7. The `onCommandStarted`/`onCommandFinished` events are available for future UI consumers (decoration addon, command history panel).

### Acceptance criteria

- [x] New shell integration addon loads in the renderer xterm
- [x] After replay, addon deserializes `SerializedCommandDetectionCapability` from the replay event
- [x] Finished commands are deserialized into xterm markers at correct line positions
- [x] Deserialized commands have `wasReplayed: true`
- [x] `onCommandFinished` fires for each deserialized finished command
- [x] Partial command (no `endLine`) restores as current command, fires `onCommandStarted`
- [x] `isWindowsPty`, `hasRichCommandDetection`, and `promptInputModel` state restore correctly
- [ ] Addon processes live OSC sequences for new commands after deserialization
- [x] Tests verify marker registration at correct line offsets
- [x] Tests verify lifecycle events fire for deserialized commands
- [ ] Tests verify live command detection works after deserialization

### Blocked by

- Blocked by "Issue 1: Positional metadata on commands" — needs populated positional fields to register meaningful markers.

### User stories addressed

- User story 20: Command detection state survives full roundtrip
- User story 21: Nonce-verified commands marked as trusted after recovery
- User story 22: `onCommandStarted`/`onCommandFinished` events fire after deserialization

---

## Issue 10: Replay input guard

### What to build

Block renderer input, resize, and flow control ack messages during terminal replay to prevent state corruption. VS Code sets `_inReplay = true` on both pty host and renderer, dropping all input/resize/signal/ack during replay.

End-to-end behavior:
1. Server-side (data channel): After sending `encodeReplay()`, incoming renderer messages (input keystrokes, resize requests, flow control acks) are dropped until `encodeReplayComplete()` is sent.
2. Client-side (renderer): When `replayStatus === 'replaying'`, the `send()` function no-ops (drops user input). The terminal pane does not forward resize events during replay.
3. After `replayComplete`, both sides resume normal operation immediately.
4. The guard is imperceptible during normal fast replays. The existing "Restoring terminal..." overlay covers the visual gap.

### Acceptance criteria

- [x] Data channel drops incoming renderer input messages during replay window
- [x] Data channel drops incoming renderer resize messages during replay window
- [x] Data channel drops incoming renderer ack messages during replay window
- [x] Renderer `send()` function no-ops when `replayStatus === 'replaying'`
- [x] Renderer does not forward resize events during replay
- [x] Input and resize resume immediately after `replayComplete`
- [x] No perceptible delay after replay completes
- [x] Tests verify input is dropped during replay on the data channel
- [x] Tests verify resize is dropped during replay on the data channel
- [x] Tests verify input resumes after replayComplete

### Blocked by

None — can start immediately.

### User stories addressed

- User story 14: Renderer blocks input/resize during replay
- User story 15: Renderer resumes input immediately after replay completes

---

## Issue 11: rawReviveBuffer optimization

### What to build

Avoid cumulative data loss from repeated serialize/deserialize cycles on idle terminals by reusing the original raw buffer for terminals that haven't been interacted with since recovery.

End-to-end behavior:
1. Each terminal tracks an interaction state: `None` (never interacted), `ReplayOnly` (replayed but no user input), `Session` (user has typed, resized, or caused a title change).
2. When a terminal is revived, the raw replay buffer data is stored alongside the xterm state. The interaction state is set to `None`, then `ReplayOnly` after replay triggers.
3. On serialization: if the terminal is in `None` or `ReplayOnly` state, the persistence layer returns the stored raw buffer directly instead of re-serializing through the xterm serialize addon.
4. On user interaction (input write, explicit resize from renderer, title change), the raw buffer reference is freed and the interaction state transitions to `Session`. Subsequent serializations use the live xterm state.
5. The headless terminal manager exposes a `freeRawReviveBuffer(terminalId)` method. The terminal manager calls this on interaction events.

### Acceptance criteria

- [x] Per-terminal interaction state tracks `None`, `ReplayOnly`, and `Session`
- [x] Raw revive buffer stored on terminal revival
- [x] Serialization in `None`/`ReplayOnly` state returns raw buffer directly
- [x] Serialization in `Session` state uses live xterm serialize addon
- [x] User input transitions state to `Session` and frees raw buffer
- [x] User resize transitions state to `Session` and frees raw buffer
- [x] Title change transitions state to `Session` and frees raw buffer
- [x] `freeRawReviveBuffer(terminalId)` method exposed on headless terminal manager
- [x] Tests verify raw buffer reuse for idle terminals
- [x] Tests verify fresh serialization after user interaction
- [x] Tests verify state transitions on each interaction type
