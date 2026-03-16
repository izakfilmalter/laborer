/**
 * Agent Hook HTTP Route — Agent lifecycle status reporting
 *
 * Provides `POST /hook/agent-status` for agent CLIs (Claude Code,
 * OpenCode, etc.) to report their lifecycle state transitions.
 *
 * When an agent CLI is spawned inside a laborer terminal, hook commands
 * are injected that call this endpoint on lifecycle events (session
 * start, stop, notification, prompt submit). The terminal service uses
 * this information to accurately determine whether an agent is actively
 * working or idle/waiting for user input — information that cannot be
 * derived from process tree inspection alone, since interactive agent
 * CLIs stay running as foreground processes in both states.
 *
 * Request body (JSON):
 * ```json
 * {
 *   "terminalId": "<terminal UUID>",
 *   "event": "active" | "waiting_for_input" | "clear"
 * }
 * ```
 *
 * Events:
 * - `active` — agent is actively working (session started, user submitted prompt)
 * - `waiting_for_input` — agent is idle / needs user input (stop, notification)
 * - `clear` — remove hook override, revert to ps-based detection
 *
 * The endpoint is intentionally a plain HTTP route (not Effect RPC)
 * so hook commands can call it with a simple `curl` invocation.
 *
 * @see packages/terminal/src/services/terminal-manager.ts — setAgentStatusFromHook
 */

import {
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from '@effect/platform'
import { Effect, type Layer } from 'effect'
import { TerminalManager } from '../services/terminal-manager.js'

/** Valid event values for the agent status hook. */
const VALID_EVENTS = new Set(['active', 'waiting_for_input', 'clear'])

/**
 * Agent hook route layer.
 *
 * Adds `POST /hook/agent-status` to the Default HTTP router.
 */
const AgentHookRouteLive = HttpRouter.Default.use((router) =>
  Effect.gen(function* () {
    const terminalManager = yield* TerminalManager

    yield* router.addRoute(
      HttpRouter.makeRoute(
        'POST',
        '/hook/agent-status',
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest
          const body = (yield* request.json) as {
            terminalId?: unknown
            event?: unknown
          }

          const { terminalId, event } = body

          if (typeof terminalId !== 'string' || terminalId === '') {
            return yield* HttpServerResponse.json(
              { error: 'Missing or invalid "terminalId" field' },
              { status: 400 }
            )
          }

          if (typeof event !== 'string' || !VALID_EVENTS.has(event)) {
            return yield* HttpServerResponse.json(
              {
                error: `Invalid "event" field. Must be one of: ${[...VALID_EVENTS].join(', ')}`,
              },
              { status: 400 }
            )
          }

          yield* terminalManager.setAgentStatusFromHook(
            terminalId,
            event as 'active' | 'waiting_for_input' | 'clear'
          )

          return yield* HttpServerResponse.json({ ok: true })
        }).pipe(
          Effect.catchAll((error) =>
            HttpServerResponse.json(
              { error: error instanceof Error ? error.message : String(error) },
              { status: 500 }
            )
          )
        )
      )
    )
  })
) satisfies Layer.Layer<never, never, TerminalManager>

export { AgentHookRouteLive }
