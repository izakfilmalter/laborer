/**
 * Terminal RPC Handlers
 *
 * Implements handler logic for the TerminalRpcs group defined in
 * `@laborer/shared/rpc`. Each handler delegates to the TerminalManager
 * Effect service for the actual terminal operations.
 *
 * The handler layer (`TerminalRpcsLive`) is wired into the terminal
 * service's `main.ts` via `RpcServer.layer(TerminalRpcs)` at `POST /rpc`.
 *
 * Pattern follows the server's `LaborerRpcsLive` in
 * `packages/server/src/rpc/handlers.ts`:
 * - Destructure payload from each RPC call
 * - `yield* ServiceTag` to access Effect services
 * - Delegate to service methods
 * - Return shaped responses matching the success schema
 *
 * The `terminal.events` endpoint is a streaming RPC that subscribes to
 * the TerminalManager's lifecycle PubSub and pushes events as they occur.
 * Each subscriber gets an independent stream of events.
 *
 * @see PRD-terminal-extraction.md
 * @see Issue #139: Terminal RPC handlers
 * @see Issue #142: Terminal event stream RPC
 */

import {
  type AgentStatusSnapshot,
  type TerminalLifecycleEventSchema,
  TerminalRpcError,
  TerminalRpcs,
} from '@laborer/shared/rpc'
import { Cause, Effect, Queue, Stream } from 'effect'
import {
  type TerminalLifecycleEvent,
  TerminalManager,
} from '../services/terminal-manager.js'
import { TERMINAL_ATTACH_CALLBACK_ITEMS_DEFAULT } from '../services/terminal-transport.js'

/**
 * Converts a TerminalLifecycleEvent (from TerminalManager's PubSub) to
 * the TerminalLifecycleEventSchema shape expected by the RPC stream.
 *
 * The internal events carry full TerminalRecord objects for Spawned and
 * Restarted events. The schema events carry only the essential fields.
 */
export const toLifecycleEventSchema = (
  event: TerminalLifecycleEvent
): TerminalLifecycleEventSchema => {
  switch (event._tag) {
    case 'Spawned':
      return {
        _tag: 'Spawned' as const,
        id: event.terminal.id,
        workspaceId: event.terminal.workspaceId,
        command: event.terminal.command,
        status: event.terminal.status,
      }
    case 'StatusChanged':
      return {
        _tag: 'StatusChanged' as const,
        id: event.id,
        status: event.status,
      }
    case 'Exited':
      return {
        _tag: 'Exited' as const,
        id: event.id,
        exitCode: event.exitCode,
        signal: event.signal,
      }
    case 'Removed':
      return {
        _tag: 'Removed' as const,
        id: event.id,
      }
    case 'Restarted':
      return {
        _tag: 'Restarted' as const,
        id: event.terminal.id,
        workspaceId: event.terminal.workspaceId,
        command: event.terminal.command,
        status: event.terminal.status,
      }
    case 'ProcessChanged':
      return {
        _tag: 'ProcessChanged' as const,
        terminal: toTerminalInfo(event.terminal),
      }
    default: {
      const _exhaustive: never = event
      return _exhaustive
    }
  }
}

/**
 * Converts a TerminalRecord (from TerminalManager) to the TerminalInfo
 * shape expected by the RPC response schema. The two types have the same
 * fields, but we spread explicitly for type safety — if the schemas
 * diverge in the future, this function will catch the mismatch at
 * compile time.
 */
export const toTerminalInfo = (record: {
  readonly agentStatus: AgentStatusSnapshot | null
  readonly args: readonly string[]
  readonly command: string
  readonly cwd: string
  readonly foregroundProcess: {
    readonly category: 'agent' | 'editor' | 'devServer' | 'shell' | 'unknown'
    readonly label: string
    readonly rawName: string
  } | null
  readonly hasChildProcess: boolean
  readonly id: string
  readonly processChain: readonly {
    readonly category: 'agent' | 'editor' | 'devServer' | 'shell' | 'unknown'
    readonly label: string
    readonly rawName: string
  }[]
  readonly sessionTitle: string | null
  readonly status: 'running' | 'stopped'
  readonly workspaceId: string
}) => ({
  id: record.id,
  workspaceId: record.workspaceId,
  command: record.command,
  args: [...record.args],
  cwd: record.cwd,
  agentStatus: record.agentStatus,
  foregroundProcess: record.foregroundProcess,
  hasChildProcess: record.hasChildProcess,
  processChain: [...record.processChain],
  sessionTitle: record.sessionTitle,
  status: record.status,
})

/**
 * RPC handler layer for the TerminalRpcs group.
 *
 * All 7 terminal RPC endpoints are implemented:
 * - terminal.spawn: creates a new PTY with command, cwd, env, dimensions
 * - terminal.write: sends input data to a terminal's PTY stdin
 * - terminal.resize: resizes a terminal's PTY dimensions
 * - terminal.kill: stops the PTY process (terminal retained in memory)
 * - terminal.remove: kills (if running) and fully removes from memory
 * - terminal.restart: kills and respawns with same command/config
 * - terminal.list: returns all terminals (running and stopped)
 */
export const TerminalRpcsLive = TerminalRpcs.toLayer(
  Effect.gen(function* () {
    const tm = yield* TerminalManager

    return {
      // -------------------------------------------------------------------
      // terminal.spawn — create a new terminal
      // -------------------------------------------------------------------
      'terminal.spawn': ({
        command,
        args,
        cwd,
        env,
        id,
        cols,
        rows,
        workspaceId,
      }) =>
        Effect.gen(function* () {
          const record = yield* tm.spawn({
            command,
            args: args ?? [],
            cwd,
            env: env ?? undefined,
            id: id ?? undefined,
            cols,
            rows,
            workspaceId,
          })
          return toTerminalInfo(record)
        }),

      // -------------------------------------------------------------------
      // terminal.write — send input to a terminal
      // -------------------------------------------------------------------
      'terminal.write': ({ id, data }) => tm.write(id, data),

      'terminal.attach': ({ id, leaseId, cursor, epoch }) =>
        Stream.callback(
          (queue) =>
            Effect.acquireRelease(
              tm.attach(
                id,
                {
                  ...(cursor === undefined ? {} : { cursor }),
                  ...(epoch === undefined ? {} : { epoch }),
                  leaseId,
                },
                (event) => {
                  const offered = Queue.offerUnsafe(queue, event)
                  if (!offered) {
                    Queue.failCauseUnsafe(
                      queue,
                      Cause.fail(
                        new TerminalRpcError({
                          message: 'Terminal attach callback buffer overflowed',
                          code: 'TERMINAL_ATTACH_OVERFLOW',
                        })
                      )
                    )
                  }
                  return offered
                }
              ),
              ({ subscriberId }) => tm.unsubscribe(id, subscriberId)
            ),
          {
            bufferSize: TERMINAL_ATTACH_CALLBACK_ITEMS_DEFAULT,
            strategy: 'dropping',
          }
        ),

      'terminal.ack': ({ id, leaseId, cursor }) =>
        tm.acknowledge(id, leaseId, cursor),

      'terminal.transportMetrics': ({ id }) => tm.transportMetrics(id),

      'terminal.hostStatus': () => tm.hostStatus(),

      'terminal.restartHost': () => tm.restartHost(),

      // -------------------------------------------------------------------
      // terminal.resize — resize a terminal's PTY
      // -------------------------------------------------------------------
      'terminal.resize': ({ id, cols, rows }) => tm.resize(id, cols, rows),

      // -------------------------------------------------------------------
      // terminal.kill — stop the PTY (terminal retained in memory)
      // -------------------------------------------------------------------
      'terminal.kill': ({ id }) => tm.kill(id),

      // -------------------------------------------------------------------
      // terminal.remove — kill (if running) and fully remove from memory
      // -------------------------------------------------------------------
      'terminal.remove': ({ id }) => tm.remove(id),

      // -------------------------------------------------------------------
      // terminal.restart — kill and respawn with same command/config
      // -------------------------------------------------------------------
      'terminal.restart': ({ id }) =>
        Effect.gen(function* () {
          const record = yield* tm.restart(id)
          return toTerminalInfo(record)
        }),

      // -------------------------------------------------------------------
      // terminal.list — return all terminals (running + stopped)
      // -------------------------------------------------------------------
      'terminal.list': () =>
        Effect.gen(function* () {
          const records = yield* tm.listTerminals()
          return records.map(toTerminalInfo)
        }),

      // -------------------------------------------------------------------
      // terminal.setAgentStatus — external hook status override
      // -------------------------------------------------------------------
      'terminal.setAgentStatus': ({ id, report }) =>
        tm.setAgentStatusFromHook(id, report),

      'terminal.reportWorkspacePresence': ({
        clientId,
        sequence,
        workspaceIds,
      }) =>
        tm.reportWorkspacePresence(clientId, sequence, new Set(workspaceIds)),

      // -------------------------------------------------------------------
      // terminal.events — streaming lifecycle events
      // -------------------------------------------------------------------
      'terminal.events': () =>
        Stream.fromPubSub(tm.lifecycleEvents).pipe(
          Stream.map(toLifecycleEventSchema)
        ),
    }
  })
)
