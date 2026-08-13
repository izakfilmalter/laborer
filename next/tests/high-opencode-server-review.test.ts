import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect, Ref } from 'effect'
import { afterEach, describe, expect, it } from 'vitest'
import { makeOpenCodeWorkspaceSessionClient } from '../src/adapters/opencode-agents.ts'
import { ExternalInputEvent } from '../src/application.ts'
import { ThreadId } from '../src/core/domain.ts'
import {
  type ConversationAgentRequest,
  ImplementationAgent,
  makeReferenceCodingApplication,
  WorktreeManager,
} from '../src/reference-coding-application.ts'
import { makeTempDirectoryScoped } from './support/temp-directory.ts'

const sandboxes = new Set<string>()
const OPEN_CODE_MESSAGE_ID_PATTERN = /^msg_[0-9a-f]{64}$/
const OPEN_CODE_SESSION_ID_PATTERN = /^ses_[0-9a-f]{60}$/

const waitForFile = async (path: string): Promise<void> => {
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    try {
      await readFile(path)
      return
    } catch {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 20))
    }
  }
  throw new Error('Timed out waiting for the fake OpenCode server')
}

const processExists = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const unusedTcpPort = (): Promise<number> =>
  new Promise((resolvePromise, rejectPromise) => {
    const server = createServer()
    server.once('error', rejectPromise)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        server.close()
        rejectPromise(new Error('Could not allocate a local OpenCode port'))
        return
      }
      server.close((error) => {
        if (error !== undefined) {
          rejectPromise(error)
          return
        }
        resolvePromise(address.port)
      })
    })
  })

afterEach(async () => {
  await Promise.all(
    [...sandboxes].map((sandbox) =>
      rm(sandbox, { force: true, recursive: true })
    )
  )
  sandboxes.clear()
})

describe('OpenCode server lifecycle', () => {
  it('accepts fresh reference-coding Conversation identities without provider inference', async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const sandbox = yield* makeTempDirectoryScoped(
            'laborer-opencode-identity-regression-'
          )
          const requests = yield* Ref.make<readonly ConversationAgentRequest[]>(
            []
          )
          const application = yield* makeReferenceCodingApplication({
            conversationAgent: {
              handle: (request) =>
                Ref.update(requests, (current) => [...current, request]).pipe(
                  Effect.as([] as const)
                ),
            },
            implementationAgent: ImplementationAgent.of({
              start: (request) =>
                Effect.succeed({
                  completion: Effect.void,
                  resume: () => Effect.void,
                  sessionId: request.implementationSessionId,
                }),
            }),
            worktreeManager: WorktreeManager.of({
              create: () => Effect.succeed({ workingDirectory: sandbox }),
            }),
          })
          yield* application.handle(
            ExternalInputEvent.make({
              conversationId: ThreadId.make(
                'workspace:T04TEST:conversation-session:1'
              ),
              eventId: 'event:opencode-identity-regression',
              payload: {},
              source: 'test',
            }),
            () => Effect.void,
            (event) =>
              Effect.succeed({
                decision: {
                  _tag: 'Accepted' as const,
                  eventId: event.eventId,
                },
                scheduling: 'Scheduled' as const,
              })
          )
          const request = (yield* Ref.get(requests))[0]
          expect(request).toBeDefined()
          if (request === undefined) {
            return
          }
          expect(request.conversationId).toBe(
            'workspace:T04TEST:conversation-session:1'
          )
          expect(request.conversationSessionId).toMatch(
            OPEN_CODE_SESSION_ID_PATTERN
          )
          expect(request.conversationSessionId).not.toBe(request.conversationId)
          expect(request.promptId).toMatch(OPEN_CODE_MESSAGE_ID_PATTERN)

          const port = yield* Effect.promise(unusedTcpPort)
          const client = yield* makeOpenCodeWorkspaceSessionClient({
            environment: {
              HOME: sandbox,
              OPENCODE_DISABLE_AUTOUPDATE: 'true',
              PATH: process.env.PATH,
              XDG_CACHE_HOME: join(sandbox, 'cache'),
              XDG_CONFIG_HOME: join(sandbox, 'config'),
              XDG_DATA_HOME: join(sandbox, 'data'),
            },
            hostname: '127.0.0.1',
            port,
            workspaceDirectory: sandbox,
          })
          const identity = {
            sessionId: request.conversationSessionId,
            workingDirectory: sandbox,
          }

          expect(yield* client.sessionExists(identity)).toBe(false)
          yield* client.createSession(identity)

          expect(yield* client.sessionExists(identity)).toBe(true)
        })
      )
    )
  }, 30_000)

  it('continuously drains both output streams after startup and completes bounded shutdown', async () => {
    const sandbox = await mkdtemp(
      join(await realpath(tmpdir()), 'laborer-high-opencode-output-')
    )
    sandboxes.add(sandbox)
    const outputDrainedPath = join(sandbox, 'output-drained')
    const pidPath = join(sandbox, 'server.pid')
    await writeFile(
      join(sandbox, 'opencode2'),
      `#!/bin/sh
trap '' TERM
printf '%s' "$$" > "$PID_PATH"
printf 'opencode server listening on http://127.0.0.1:43210\n'
/usr/bin/yes stdout | /usr/bin/head -c 1048576
/usr/bin/yes stderr | /usr/bin/head -c 1048576 >&2
printf 'drained' > "$OUTPUT_DRAINED_PATH"
while :; do /bin/sleep 1; done
`,
      { mode: 0o700 }
    )
    const lifecycleStartedAt = Date.now()
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* makeOpenCodeWorkspaceSessionClient({
            command: join(sandbox, 'opencode2'),
            environment: {
              OUTPUT_DRAINED_PATH: outputDrainedPath,
              PATH: sandbox,
              PID_PATH: pidPath,
            },
            hostname: '127.0.0.1',
            port: 0,
            serverTimeoutMs: 2000,
            workspaceDirectory: sandbox,
          })
          yield* Effect.promise(() => waitForFile(outputDrainedPath))
        })
      )
    )
    const pid = Number(await readFile(pidPath, 'utf8'))

    expect(await readFile(outputDrainedPath, 'utf8')).toBe('drained')
    expect(processExists(pid)).toBe(false)
    expect(Date.now() - lifecycleStartedAt).toBeLessThan(4000)
  })
})
