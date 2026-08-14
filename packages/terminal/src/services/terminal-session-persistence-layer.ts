import { Effect, Layer, Result } from 'effect'
import { TerminalManager } from './terminal-manager.js'
import { createTerminalSessionPersistence } from './terminal-session-persistence.js'

/**
 * Checkpoint/revival lifecycle for the detached PTY host. Persistence finishes
 * before the terminal manager's own shutdown finalizer kills its PTYs.
 */
export const TerminalSessionPersistenceLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const terminalManager = yield* TerminalManager
    const persistence = createTerminalSessionPersistence()
    const persistedState = yield* Effect.sync(() =>
      persistence.loadPersistedState()
    )

    if (persistedState !== null) {
      for (const saved of persistedState.terminals) {
        const result = yield* Effect.result(
          terminalManager.spawn({
            args: [...saved.args],
            cols: saved.cols,
            command: saved.command,
            cwd: saved.cwd,
            env: { ...saved.env },
            id: saved.id,
            restored: true,
            rows: saved.rows,
            workspaceId: saved.workspaceId,
          })
        )
        if (Result.isSuccess(result)) {
          persistence.registerTerminal(saved.id, saved.cols, saved.rows)
          persistence.restoreReplayEvent(saved.id, saved.replayEvent)
          yield* terminalManager.setRevivedReplayEvent(
            saved.id,
            saved.replayEvent
          )
        }
      }
    }

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        const terminals = yield* terminalManager.getTerminals()
        yield* Effect.sync(() => {
          // A PTY can emit startup bytes before the lifecycle subscriber is
          // scheduled. The headless snapshot is authoritative at shutdown,
          // so use it as the checkpoint boundary instead of risking a gap.
          for (const terminal of terminals) {
            persistence.registerTerminal(
              terminal.id,
              terminal.cols,
              terminal.rows
            )
            persistence.restoreReplayEvent(terminal.id, {
              events: [
                {
                  cols: terminal.cols,
                  data: terminalManager.getScreenState(terminal.id),
                  rows: terminal.rows,
                },
              ],
            })
          }
          persistence.serializeState(
            () =>
              terminals.map((terminal) => ({
                args: terminal.args,
                command: terminal.command,
                cwd: terminal.cwd,
                env: terminal.env,
                id: terminal.id,
                status: terminal.status,
                workspaceId: terminal.workspaceId,
              })),
            (terminalId) => terminalManager.getScreenState(terminalId),
            (terminalId) => terminalManager.getCommandDetectionState(terminalId)
          )
        })
      })
    )
  })
)
