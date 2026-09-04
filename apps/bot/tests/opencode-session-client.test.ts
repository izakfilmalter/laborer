import { createHash } from 'node:crypto'
import { assert, describe, it } from '@effect/vitest'
import { Effect, Fiber } from 'effect'
import { TestClock } from 'effect/testing'
import {
  makeOpenCodeSessionClientFromV2Api,
  type OpenCodeV2SessionApi,
} from '../src/adapters/opencode-agents.ts'

const OPENCODE_MAX_SESSION_MESSAGES = 200
const OPEN_CODE_SESSION_ID_PATTERN = /^ses_[0-9a-f]{60}$/
const LEGACY_LOGICAL_SESSION_ID =
  'ses_d3308952a82b5844000a4eb5ceb2f4964c5a03fc273f29200f14a681f542ca83'

describe('OpenCode v2 session client', () => {
  it.effect('maps legacy logical IDs to deterministic safe physical IDs', () =>
    Effect.gen(function* () {
      const calls: Array<readonly [string, unknown]> = []
      const sessions = new Map<string, string>()
      const messages = new Map<
        string,
        readonly {
          readonly finish?: string
          readonly id: string
          readonly role: 'assistant' | 'user'
          readonly status?: 'completed' | 'error' | 'in-progress'
          readonly text: string
        }[]
      >()
      const physicalId = (promptId: string): string =>
        `ses_${createHash('sha256')
          .update(JSON.stringify([LEGACY_LOGICAL_SESSION_ID, promptId]))
          .digest('hex')
          .slice(0, 60)}`
      const api: OpenCodeV2SessionApi = {
        create: (input) => {
          calls.push(['create', input])
          sessions.set(input.id, input.workingDirectory)
          return Promise.resolve({ id: input.id })
        },
        get: (input) => {
          calls.push(['get', input])
          const workingDirectory = sessions.get(input.sessionId)
          return workingDirectory === undefined
            ? Promise.reject({ _tag: 'SessionNotFoundError' })
            : Promise.resolve({ id: input.sessionId, workingDirectory })
        },
        interrupt: (input) => {
          calls.push(['interrupt', input])
          return Promise.resolve()
        },
        messages: (input) => {
          calls.push(['messages', input])
          return Promise.resolve(messages.get(input.sessionId) ?? [])
        },
        prompt: (input) => {
          calls.push(['prompt', input])
          messages.set(input.sessionId, [
            {
              finish: 'stop',
              id: `response:${input.promptId}`,
              role: 'assistant',
              status: 'completed',
              text: 'done',
            },
            { id: input.promptId, role: 'user', text: input.text },
          ])
          return Promise.resolve({ id: input.promptId })
        },
        wait: (input) => {
          calls.push(['wait', input])
          return Promise.resolve()
        },
      }
      const client = makeOpenCodeSessionClientFromV2Api(api, {
        agent: 'laborer',
        model: { modelID: 'gpt-5.6-sol', providerID: 'openai' },
        promptIsolation: true,
      })
      const promptIdentity = {
        promptId: 'prompt-1',
        sessionId: LEGACY_LOGICAL_SESSION_ID,
        workingDirectory: '/repo/worktree',
      }
      const expectedPhysicalId = physicalId('prompt-1')

      assert.strictEqual(
        yield* client.sessionExists({
          sessionId: LEGACY_LOGICAL_SESSION_ID,
          workingDirectory: '/repo/worktree',
        }),
        false
      )
      yield* client.createSession({
        sessionId: LEGACY_LOGICAL_SESSION_ID,
        workingDirectory: '/repo/worktree',
      })
      yield* client.submitPrompt({
        ...promptIdentity,
        text: 'input',
        tools: { bash: false, read: true },
      })
      const generatedPhysicalSessionIds = [...sessions.keys()].filter(
        (sessionId) => sessionId !== LEGACY_LOGICAL_SESSION_ID
      )
      assert.strictEqual(generatedPhysicalSessionIds.length, 1)
      for (const sessionId of generatedPhysicalSessionIds) {
        assert.strictEqual(sessionId.length, 64)
        assert.match(sessionId, OPEN_CODE_SESSION_ID_PATTERN)
      }
      yield* client.wait(promptIdentity)
      assert.deepStrictEqual(yield* client.readMessages(promptIdentity), [
        { id: 'prompt-1', role: 'user', text: 'input' },
        {
          finish: 'stop',
          id: 'response:prompt-1',
          role: 'assistant',
          status: 'completed',
          text: 'done',
        },
      ])
      yield* client.interrupt(promptIdentity)
      yield* client.submitPrompt({
        ...promptIdentity,
        text: 'input',
        tools: { bash: false, read: true },
      })

      assert.deepStrictEqual(
        calls.filter(([operation]) => operation === 'create'),
        [
          [
            'create',
            {
              agent: 'laborer',
              id: LEGACY_LOGICAL_SESSION_ID,
              model: { modelID: 'gpt-5.6-sol', providerID: 'openai' },
              workingDirectory: '/repo/worktree',
            },
          ],
          [
            'create',
            {
              agent: 'laborer',
              id: expectedPhysicalId,
              model: { modelID: 'gpt-5.6-sol', providerID: 'openai' },
              workingDirectory: '/repo/worktree',
            },
          ],
        ]
      )
      assert.deepStrictEqual(
        calls.filter(([operation]) => operation === 'prompt'),
        [
          [
            'prompt',
            {
              agent: 'laborer',
              model: { modelID: 'gpt-5.6-sol', providerID: 'openai' },
              promptId: 'prompt-1',
              sessionId: expectedPhysicalId,
              text: 'input',
              tools: { bash: false, read: true },
              workingDirectory: '/repo/worktree',
            },
          ],
        ]
      )
      assert.ok(
        calls
          .filter(([operation]) =>
            ['messages', 'wait', 'interrupt'].includes(operation)
          )
          .every(([, input]) =>
            JSON.stringify(input).includes(expectedPhysicalId)
          )
      )

      const conflictingPromptId = 'prompt-conflict'
      sessions.set(physicalId(conflictingPromptId), '/wrong/worktree')
      const conflict = yield* Effect.result(
        client.submitPrompt({
          promptId: conflictingPromptId,
          sessionId: LEGACY_LOGICAL_SESSION_ID,
          text: 'must not run',
          workingDirectory: '/repo/worktree',
        })
      )
      assert.strictEqual(conflict._tag, 'Failure')
      if (conflict._tag === 'Failure') {
        assert.strictEqual(
          conflict.failure.safeDetail,
          'OpenCode session identity conflicts'
        )
      }
      assert.ok(
        !calls.some(
          ([operation, input]) =>
            operation === 'prompt' &&
            JSON.stringify(input).includes(conflictingPromptId)
        )
      )
      assert.deepStrictEqual(
        calls.filter(([operation]) => operation === 'get'),
        [
          ['get', { sessionId: LEGACY_LOGICAL_SESSION_ID }],
          ['get', { sessionId: expectedPhysicalId }],
          ['get', { sessionId: expectedPhysicalId }],
          ['get', { sessionId: expectedPhysicalId }],
          ['get', { sessionId: physicalId(conflictingPromptId) }],
        ]
      )
    })
  )

  it.effect(
    'does not complete the exact prompt on completed tool-call assistants',
    () =>
      Effect.gen(function* () {
        let messageReads = 0
        const api: OpenCodeV2SessionApi = {
          create: (input) => Promise.resolve({ id: input.id }),
          get: (input) =>
            Promise.resolve({
              id: input.sessionId,
              workingDirectory: '/repo/worktree',
            }),
          interrupt: () => Promise.resolve(),
          messages: () => {
            messageReads += 1
            const responses = [
              {
                finish: 'tool-calls',
                id: 'tool-call-assistant',
                role: 'assistant' as const,
                status: 'completed' as const,
                text: '',
              },
            ]
            if (messageReads > 1) {
              responses.unshift({
                finish: 'stop',
                id: 'terminal-assistant',
                role: 'assistant' as const,
                status: 'completed' as const,
                text: 'final response',
              })
            }
            return Promise.resolve([
              ...responses,
              { id: 'prompt-1', role: 'user' as const, text: 'input' },
            ])
          },
          prompt: (input) => Promise.resolve({ id: input.promptId }),
          wait: () =>
            Promise.reject({
              _tag: 'ServiceUnavailableError',
              message: 'Session wait is not available yet',
              service: 'session.wait',
            }),
        }
        const client = makeOpenCodeSessionClientFromV2Api(api, {
          waitPollIntervalMs: 0,
          waitPollMaxAttempts: 2,
        })

        yield* client.wait({
          promptId: 'prompt-1',
          sessionId: 'session-1',
          workingDirectory: '/repo/worktree',
        })

        assert.strictEqual(messageReads, 2)
      })
  )

  it.effect('re-issues the idle wait when fetch times out on headers', () =>
    Effect.gen(function* () {
      let waits = 0
      const api: OpenCodeV2SessionApi = {
        create: (input) => Promise.resolve({ id: input.id }),
        get: (input) =>
          Promise.resolve({
            id: input.sessionId,
            workingDirectory: '/repo/worktree',
          }),
        interrupt: () => Promise.resolve(),
        messages: () =>
          Promise.resolve([
            {
              finish: 'stop',
              id: 'assistant-final',
              role: 'assistant' as const,
              status: 'completed' as const,
              text: 'done after a long turn',
            },
            { id: 'prompt-1', role: 'user' as const, text: 'input' },
          ]),
        prompt: (input) => Promise.resolve({ id: input.promptId }),
        wait: () => {
          waits += 1
          if (waits < 3) {
            // Node fetch surfaces undici's headers timeout as the cause.
            return Promise.reject(
              new TypeError('fetch failed', {
                cause: Object.assign(new Error('Headers Timeout Error'), {
                  code: 'UND_ERR_HEADERS_TIMEOUT',
                  name: 'HeadersTimeoutError',
                }),
              })
            )
          }
          return Promise.resolve()
        },
      }
      const client = makeOpenCodeSessionClientFromV2Api(api)

      yield* client.wait({
        promptId: 'prompt-1',
        sessionId: 'session-1',
        workingDirectory: '/repo/worktree',
      })

      assert.strictEqual(waits, 3)
    })
  )

  it.effect('completes a prompt through the turn a later steer extended', () =>
    Effect.gen(function* () {
      const api: OpenCodeV2SessionApi = {
        create: (input) => Promise.resolve({ id: input.id }),
        get: (input) =>
          Promise.resolve({
            id: input.sessionId,
            workingDirectory: '/repo/worktree',
          }),
        interrupt: () => Promise.resolve(),
        messages: () =>
          Promise.resolve([
            {
              finish: 'stop',
              id: 'later-terminal-assistant',
              role: 'assistant' as const,
              status: 'completed' as const,
              text: 'later response',
            },
            { id: 'prompt-2', role: 'user' as const, text: 'later input' },
            {
              finish: 'tool-calls',
              id: 'tool-call-assistant',
              role: 'assistant' as const,
              status: 'completed' as const,
              text: '',
            },
            { id: 'prompt-1', role: 'user' as const, text: 'input' },
          ]),
        prompt: (input) => Promise.resolve({ id: input.promptId }),
        wait: () => Promise.resolve(),
      }
      const client = makeOpenCodeSessionClientFromV2Api(api)

      const result = yield* Effect.result(
        client.wait({
          promptId: 'prompt-1',
          sessionId: 'session-1',
          workingDirectory: '/repo/worktree',
        })
      )

      // prompt-2 was promoted into prompt-1's running turn as a steer, so the
      // turn ends at the first terminal assistant after prompt-1.
      assert.strictEqual(result._tag, 'Success')
    })
  )

  it.effect(
    'does not treat a completed timestamp without finish as terminal',
    () =>
      Effect.gen(function* () {
        const api: OpenCodeV2SessionApi = {
          create: (input) => Promise.resolve({ id: input.id }),
          get: (input) =>
            Promise.resolve({
              id: input.sessionId,
              workingDirectory: '/repo/worktree',
            }),
          interrupt: () => Promise.resolve(),
          messages: () =>
            Promise.resolve([
              {
                id: 'intermediate-assistant',
                role: 'assistant' as const,
                status: 'completed' as const,
                text: 'intermediate',
              },
              { id: 'prompt-1', role: 'user' as const, text: 'input' },
            ]),
          prompt: (input) => Promise.resolve({ id: input.promptId }),
          wait: () => Promise.resolve(),
        }
        const client = makeOpenCodeSessionClientFromV2Api(api)

        const result = yield* Effect.result(
          client.wait({
            promptId: 'prompt-1',
            sessionId: 'session-1',
            workingDirectory: '/repo/worktree',
          })
        )

        assert.strictEqual(result._tag, 'Failure')
        if (result._tag === 'Failure') {
          assert.strictEqual(
            result.failure.safeDetail,
            'OpenCode prompt response did not complete'
          )
        }
      })
  )

  it.effect(
    'polls the exact prompt to terminal completion when native wait is unavailable',
    () =>
      Effect.gen(function* () {
        let messageReads = 0
        const messageReadLimits: number[] = []
        const api: OpenCodeV2SessionApi = {
          create: (input) => Promise.resolve({ id: input.id }),
          get: (input) =>
            Promise.resolve({
              id: input.sessionId,
              workingDirectory: '/repo/worktree',
            }),
          interrupt: () => Promise.resolve(),
          messages: (input) => {
            messageReads += 1
            messageReadLimits.push(input.limit)
            if (messageReads === 1) {
              return Promise.resolve([
                {
                  id: 'stale-assistant',
                  role: 'assistant' as const,
                  status: 'completed' as const,
                  text: 'stale output',
                },
              ])
            }
            if (messageReads === 2) {
              return Promise.resolve([
                {
                  id: 'pending-assistant',
                  role: 'assistant' as const,
                  status: 'in-progress' as const,
                  text: 'partial output',
                },
                { id: 'prompt-1', role: 'user' as const, text: 'input' },
                {
                  id: 'stale-assistant',
                  role: 'assistant' as const,
                  status: 'completed' as const,
                  text: 'stale output',
                },
              ])
            }
            return Promise.resolve([
              {
                finish: 'stop',
                id: 'completed-assistant',
                role: 'assistant' as const,
                status: 'completed' as const,
                text: 'fresh output',
              },
              { id: 'prompt-1', role: 'user' as const, text: 'input' },
              {
                id: 'stale-assistant',
                role: 'assistant' as const,
                status: 'completed' as const,
                text: 'stale output',
              },
            ])
          },
          prompt: (input) => Promise.resolve({ id: input.promptId }),
          wait: () =>
            Promise.reject(
              new Error('Session wait is not available yet', {
                cause: {
                  body: {
                    _tag: 'ServiceUnavailableError',
                    message: 'Session wait is not available yet',
                    service: 'session.wait',
                  },
                  status: 503,
                },
              })
            ),
        }
        const client = makeOpenCodeSessionClientFromV2Api(api, {
          waitPollIntervalMs: 0,
          waitPollMaxAttempts: 3,
        })

        yield* client.wait({
          promptId: 'prompt-1',
          sessionId: 'session-1',
          workingDirectory: '/repo/worktree',
        })

        assert.strictEqual(messageReads, 3)
        assert.ok(
          messageReadLimits.every(
            (limit) => limit <= OPENCODE_MAX_SESSION_MESSAGES
          ),
          `all message reads must use a limit at most ${OPENCODE_MAX_SESSION_MESSAGES}`
        )
      })
  )

  it.effect('fails when the assistant response terminates with an error', () =>
    Effect.gen(function* () {
      const api: OpenCodeV2SessionApi = {
        create: (input) => Promise.resolve({ id: input.id }),
        get: (input) =>
          Promise.resolve({
            id: input.sessionId,
            workingDirectory: '/repo/worktree',
          }),
        interrupt: () => Promise.resolve(),
        messages: () =>
          Promise.resolve([
            {
              id: 'failed-assistant',
              role: 'assistant' as const,
              status: 'error' as const,
              text: 'provider detail',
            },
            { id: 'prompt-1', role: 'user' as const, text: 'input' },
          ]),
        prompt: (input) => Promise.resolve({ id: input.promptId }),
        wait: () => Promise.resolve(),
      }
      const client = makeOpenCodeSessionClientFromV2Api(api)

      const result = yield* Effect.result(
        client.wait({
          promptId: 'prompt-1',
          sessionId: 'session-1',
          workingDirectory: '/repo/worktree',
        })
      )

      assert.strictEqual(result._tag, 'Failure')
      if (result._tag === 'Failure') {
        assert.strictEqual(
          result.failure.safeDetail,
          'OpenCode assistant response failed'
        )
        assert.ok(!result.failure.safeDetail?.includes('provider detail'))
      }
    })
  )

  it.effect('fails distinctly when the admitted prompt never completes', () =>
    Effect.gen(function* () {
      let messageReads = 0
      const api: OpenCodeV2SessionApi = {
        create: (input) => Promise.resolve({ id: input.id }),
        get: (input) =>
          Promise.resolve({
            id: input.sessionId,
            workingDirectory: '/repo/worktree',
          }),
        interrupt: () => Promise.resolve(),
        messages: () => {
          messageReads += 1
          return Promise.resolve([
            {
              id: 'pending-assistant',
              role: 'assistant' as const,
              status: 'in-progress' as const,
              text: 'partial',
            },
            { id: 'prompt-1', role: 'user' as const, text: 'input' },
          ])
        },
        prompt: (input) => Promise.resolve({ id: input.promptId }),
        wait: () =>
          Promise.reject({
            _tag: 'ServiceUnavailableError',
            message: 'Session wait is not available yet',
            service: 'session.wait',
          }),
      }
      const client = makeOpenCodeSessionClientFromV2Api(api, {
        waitPollIntervalMs: 0,
        waitPollMaxAttempts: 2,
      })

      const result = yield* Effect.result(
        client.wait({
          promptId: 'prompt-1',
          sessionId: 'session-1',
          workingDirectory: '/repo/worktree',
        })
      )

      assert.strictEqual(result._tag, 'Failure')
      assert.strictEqual(messageReads, 2)
      if (result._tag === 'Failure') {
        assert.strictEqual(
          result.failure.safeDetail,
          'OpenCode prompt response timed out'
        )
      }
    })
  )

  it.effect('uses the default five-minute polling cadence for four hours', () =>
    Effect.gen(function* () {
      let messageReads = 0
      const api: OpenCodeV2SessionApi = {
        create: (input) => Promise.resolve({ id: input.id }),
        get: (input) =>
          Promise.resolve({
            id: input.sessionId,
            workingDirectory: '/repo/worktree',
          }),
        interrupt: () => Promise.resolve(),
        messages: () => {
          messageReads += 1
          return Promise.resolve([
            {
              id: 'pending-assistant',
              role: 'assistant' as const,
              status: 'in-progress' as const,
              text: 'partial',
            },
            { id: 'prompt-1', role: 'user' as const, text: 'input' },
          ])
        },
        prompt: (input) => Promise.resolve({ id: input.promptId }),
        wait: () =>
          Promise.reject({
            _tag: 'ServiceUnavailableError',
            message: 'Session wait is not available yet',
            service: 'session.wait',
          }),
      }
      const client = makeOpenCodeSessionClientFromV2Api(api)
      const waitFiber = yield* client
        .wait({
          promptId: 'prompt-1',
          sessionId: 'session-1',
          workingDirectory: '/repo/worktree',
        })
        .pipe(Effect.result, Effect.forkChild)

      yield* TestClock.adjust('0 millis')
      assert.strictEqual(messageReads, 1)
      for (let interval = 1; interval < 48; interval += 1) {
        yield* TestClock.adjust('5 minutes')
      }

      assert.strictEqual(messageReads, 48)
      assert.strictEqual(waitFiber.pollUnsafe(), undefined)

      yield* TestClock.adjust('5 minutes')
      const result = yield* Fiber.join(waitFiber)

      assert.strictEqual(messageReads, 49)
      assert.strictEqual(result._tag, 'Failure')
      if (result._tag === 'Failure') {
        assert.strictEqual(
          result.failure.safeDetail,
          'OpenCode prompt response timed out'
        )
      }
    })
  )

  it.effect('fails when the exact prompt never appears', () =>
    Effect.gen(function* () {
      let messageReads = 0
      const api: OpenCodeV2SessionApi = {
        create: (input) => Promise.resolve({ id: input.id }),
        get: (input) =>
          Promise.resolve({
            id: input.sessionId,
            workingDirectory: '/repo/worktree',
          }),
        interrupt: () => Promise.resolve(),
        messages: () => {
          messageReads += 1
          return Promise.resolve([
            {
              id: 'stale-assistant',
              role: 'assistant' as const,
              status: 'completed' as const,
              text: 'stale output',
            },
          ])
        },
        prompt: (input) => Promise.resolve({ id: input.promptId }),
        wait: () =>
          Promise.reject({
            _tag: 'ServiceUnavailableError',
            message: 'Session wait is not available yet',
            service: 'session.wait',
          }),
      }
      const client = makeOpenCodeSessionClientFromV2Api(api, {
        waitPollIntervalMs: 0,
        waitPollMaxAttempts: 2,
      })

      const result = yield* Effect.result(
        client.wait({
          promptId: 'prompt-1',
          sessionId: 'session-1',
          workingDirectory: '/repo/worktree',
        })
      )

      assert.strictEqual(result._tag, 'Failure')
      assert.strictEqual(messageReads, 2)
      if (result._tag === 'Failure') {
        assert.strictEqual(
          result.failure.safeDetail,
          'OpenCode prompt is unavailable'
        )
      }
    })
  )

  it.effect('does not poll for unrelated native wait failures', () =>
    Effect.gen(function* () {
      let messageReads = 0
      const api: OpenCodeV2SessionApi = {
        create: (input) => Promise.resolve({ id: input.id }),
        get: (input) =>
          Promise.resolve({
            id: input.sessionId,
            workingDirectory: '/repo/worktree',
          }),
        interrupt: () => Promise.resolve(),
        messages: () => {
          messageReads += 1
          return Promise.resolve([])
        },
        prompt: (input) => Promise.resolve({ id: input.promptId }),
        wait: () =>
          Promise.reject({
            _tag: 'ServiceUnavailableError',
            message: 'Another service is unavailable',
            service: 'provider',
          }),
      }
      const client = makeOpenCodeSessionClientFromV2Api(api)

      const result = yield* Effect.result(
        client.wait({
          promptId: 'prompt-1',
          sessionId: 'session-1',
          workingDirectory: '/repo/worktree',
        })
      )

      assert.strictEqual(result._tag, 'Failure')
      assert.strictEqual(messageReads, 0)
      if (result._tag === 'Failure') {
        assert.strictEqual(result.failure.category, 'exit')
        assert.strictEqual(
          result.failure.safeDetail,
          'OpenCode session wait failed'
        )
      }
    })
  )

  it.effect(
    'reports a user-policy denial without replay or secret detail',
    () =>
      Effect.gen(function* () {
        let promptCalls = 0
        const api: OpenCodeV2SessionApi = {
          create: (input) => Promise.resolve({ id: input.id }),
          get: (input) =>
            Promise.resolve({
              id: input.sessionId,
              workingDirectory: '/repo/worktree',
            }),
          interrupt: () => Promise.resolve(),
          messages: () => Promise.resolve([]),
          prompt: () => {
            promptCalls += 1
            return Promise.reject(
              new Error('permission denied: SECRET_POLICY_DETAIL')
            )
          },
          wait: () => Promise.resolve(),
        }
        const client = makeOpenCodeSessionClientFromV2Api(api)

        const result = yield* Effect.result(
          client.submitPrompt({
            promptId: 'prompt-denied',
            sessionId: 'session-1',
            text: 'attempt denied operation',
            workingDirectory: '/repo/worktree',
          })
        )

        assert.strictEqual(result._tag, 'Failure')
        assert.strictEqual(promptCalls, 1)
        if (result._tag === 'Failure') {
          assert.strictEqual(
            result.failure.safeDetail,
            'OpenCode prompt submission failed'
          )
          assert.ok(
            !result.failure.safeDetail?.includes('SECRET_POLICY_DETAIL')
          )
        }
      })
  )

  it.effect(
    'removes every exact legacy wildcard allow before reuse and is idempotent',
    () =>
      Effect.gen(function* () {
        let permission: unknown = [
          { action: 'allow', pattern: '*', permission: '*' },
          { action: 'allow', pattern: '*', permission: '*' },
        ]
        const updates: unknown[] = []
        const api: OpenCodeV2SessionApi = {
          create: (input) => Promise.resolve({ id: input.id }),
          get: (input) =>
            Promise.resolve({
              id: input.sessionId,
              workingDirectory: '/repo/worktree',
            }),
          getPermission: () => Promise.resolve(permission),
          interrupt: () => Promise.resolve(),
          messages: () => Promise.resolve([]),
          prompt: (input) => Promise.resolve({ id: input.promptId }),
          updatePermission: (input) => {
            updates.push(input)
            permission = input.permission
            return Promise.resolve()
          },
          wait: () => Promise.resolve(),
        }
        const client = makeOpenCodeSessionClientFromV2Api(api)
        const identity = {
          sessionId: 'legacy-session',
          workingDirectory: '/repo/worktree',
        }

        assert.ok(client.prepareSessionForReuse)
        yield* client.prepareSessionForReuse(identity)
        yield* client.prepareSessionForReuse(identity)

        assert.deepStrictEqual(permission, [])
        assert.deepStrictEqual(updates, [
          { permission: [], sessionId: 'legacy-session' },
        ])
      })
  )

  it.effect(
    'preserves user rules and order while removing only exact legacy entries',
    () =>
      Effect.gen(function* () {
        const userRules = [
          { action: 'deny' as const, pattern: '*', permission: '*' },
          { action: 'ask' as const, pattern: '*', permission: 'bash' },
          { action: 'allow' as const, pattern: 'safe-*', permission: '*' },
          {
            action: 'allow' as const,
            owner: 'user',
            pattern: '*',
            permission: '*',
          },
        ]
        let updated: unknown = null
        const api: OpenCodeV2SessionApi = {
          create: (input) => Promise.resolve({ id: input.id }),
          get: (input) =>
            Promise.resolve({
              id: input.sessionId,
              workingDirectory: '/repo/worktree',
            }),
          getPermission: () =>
            Promise.resolve([
              userRules[0],
              { action: 'allow', pattern: '*', permission: '*' },
              userRules[1],
              { action: 'allow', pattern: '*', permission: '*' },
              userRules[2],
              userRules[3],
            ]),
          interrupt: () => Promise.resolve(),
          messages: () => Promise.resolve([]),
          prompt: (input) => Promise.resolve({ id: input.promptId }),
          updatePermission: (input) => {
            updated = input.permission
            return Promise.resolve()
          },
          wait: () => Promise.resolve(),
        }
        const client = makeOpenCodeSessionClientFromV2Api(api)

        assert.ok(client.prepareSessionForReuse)
        yield* client.prepareSessionForReuse({
          sessionId: 'mixed-session',
          workingDirectory: '/repo/worktree',
        })

        assert.deepStrictEqual(updated, userRules)
      })
  )

  it.effect('does not mutate a session without the legacy entry', () =>
    Effect.gen(function* () {
      let updates = 0
      const permission = [
        { action: 'deny' as const, pattern: '*', permission: '*' },
        { action: 'ask' as const, pattern: '*', permission: '*' },
        { action: 'allow' as const, pattern: 'command-*', permission: '*' },
      ]
      const api: OpenCodeV2SessionApi = {
        create: (input) => Promise.resolve({ id: input.id }),
        get: (input) =>
          Promise.resolve({
            id: input.sessionId,
            workingDirectory: '/repo/worktree',
          }),
        getPermission: () => Promise.resolve(permission),
        interrupt: () => Promise.resolve(),
        messages: () => Promise.resolve([]),
        prompt: (input) => Promise.resolve({ id: input.promptId }),
        updatePermission: () => {
          updates += 1
          return Promise.resolve()
        },
        wait: () => Promise.resolve(),
      }
      const client = makeOpenCodeSessionClientFromV2Api(api)

      assert.ok(client.prepareSessionForReuse)
      yield* client.prepareSessionForReuse({
        sessionId: 'current-session',
        workingDirectory: '/repo/worktree',
      })

      assert.strictEqual(updates, 0)
    })
  )

  it.effect(
    'fails closed when legacy permission inspection is unavailable or ambiguous',
    () =>
      Effect.gen(function* () {
        for (const permission of ['malformed', null] as const) {
          let updates = 0
          const api: OpenCodeV2SessionApi = {
            create: (input) => Promise.resolve({ id: input.id }),
            get: (input) =>
              Promise.resolve({
                id: input.sessionId,
                workingDirectory: '/repo/worktree',
              }),
            getPermission: () => Promise.resolve(permission),
            interrupt: () => Promise.resolve(),
            messages: () => Promise.resolve([]),
            prompt: (input) => Promise.resolve({ id: input.promptId }),
            updatePermission: () => {
              updates += 1
              return Promise.resolve()
            },
            wait: () => Promise.resolve(),
          }
          const client = makeOpenCodeSessionClientFromV2Api(api)
          assert.ok(client.prepareSessionForReuse)

          const result = yield* Effect.result(
            client.prepareSessionForReuse({
              sessionId: 'ambiguous-session',
              workingDirectory: '/repo/worktree',
            })
          )

          assert.strictEqual(result._tag, 'Failure')
          assert.strictEqual(updates, 0)
        }

        const unavailable = makeOpenCodeSessionClientFromV2Api({
          create: (input) => Promise.resolve({ id: input.id }),
          get: (input) =>
            Promise.resolve({
              id: input.sessionId,
              workingDirectory: '/repo/worktree',
            }),
          interrupt: () => Promise.resolve(),
          messages: () => Promise.resolve([]),
          prompt: (input) => Promise.resolve({ id: input.promptId }),
          wait: () => Promise.resolve(),
        })
        assert.ok(unavailable.prepareSessionForReuse)
        assert.strictEqual(
          (yield* Effect.result(
            unavailable.prepareSessionForReuse({
              sessionId: 'unavailable-session',
              workingDirectory: '/repo/worktree',
            })
          ))._tag,
          'Failure'
        )
      })
  )

  it.effect('fails closed when legacy permission cleanup cannot persist', () =>
    Effect.gen(function* () {
      const api: OpenCodeV2SessionApi = {
        create: (input) => Promise.resolve({ id: input.id }),
        get: (input) =>
          Promise.resolve({
            id: input.sessionId,
            workingDirectory: '/repo/worktree',
          }),
        getPermission: () =>
          Promise.resolve([{ action: 'allow', pattern: '*', permission: '*' }]),
        interrupt: () => Promise.resolve(),
        messages: () => Promise.resolve([]),
        prompt: (input) => Promise.resolve({ id: input.promptId }),
        updatePermission: () => Promise.reject(new Error('private detail')),
        wait: () => Promise.resolve(),
      }
      const client = makeOpenCodeSessionClientFromV2Api(api)
      assert.ok(client.prepareSessionForReuse)

      const result = yield* Effect.result(
        client.prepareSessionForReuse({
          sessionId: 'cleanup-failure-session',
          workingDirectory: '/repo/worktree',
        })
      )

      assert.strictEqual(result._tag, 'Failure')
      if (result._tag === 'Failure') {
        assert.strictEqual(
          result.failure.safeDetail,
          'OpenCode legacy permission cleanup failed'
        )
        assert.ok(!result.failure.safeDetail?.includes('private detail'))
      }
    })
  )

  it.effect(
    'maps identities without installing or rewriting OpenCode permissions',
    () =>
      Effect.gen(function* () {
        const calls: Array<readonly [string, unknown]> = []
        const api: OpenCodeV2SessionApi = {
          create: (input) => {
            calls.push(['create', input])
            return Promise.resolve({ id: input.id })
          },
          get: (input) => {
            calls.push(['get', input])
            return Promise.resolve({
              id: input.sessionId,
              workingDirectory: '/repo/worktree',
            })
          },
          interrupt: (input) => {
            calls.push(['interrupt', input])
            return Promise.resolve()
          },
          messages: (input) => {
            calls.push(['messages', input])
            return Promise.resolve([
              {
                finish: 'stop',
                id: 'response-1',
                role: 'assistant',
                status: 'completed',
                text: 'output',
              },
              { id: 'prompt-1', role: 'user', text: 'input' },
            ] as const)
          },
          prompt: (input) => {
            calls.push(['prompt', input])
            return Promise.resolve({ id: input.promptId })
          },
          wait: (input) => {
            calls.push(['wait', input])
            return Promise.resolve()
          },
        }
        const client = makeOpenCodeSessionClientFromV2Api(api, {
          agent: 'laborer',
          model: { modelID: 'gpt-5.6-sol', providerID: 'openai' },
        })
        const identity = {
          sessionId: 'session-1',
          workingDirectory: '/repo/worktree',
        }

        assert.strictEqual(yield* client.sessionExists(identity), true)
        yield* client.createSession(identity)
        yield* client.submitPrompt({
          ...identity,
          promptId: 'prompt-1',
          text: 'input',
        })
        yield* client.wait({ ...identity, promptId: 'prompt-1' })
        assert.deepStrictEqual(
          yield* client.readMessages({ ...identity, promptId: 'prompt-1' }),
          [
            { id: 'prompt-1', role: 'user', text: 'input' },
            {
              finish: 'stop',
              id: 'response-1',
              role: 'assistant',
              status: 'completed',
              text: 'output',
            },
          ]
        )
        yield* client.interrupt({ ...identity, promptId: 'prompt-1' })

        assert.deepStrictEqual(calls, [
          ['get', { sessionId: 'session-1' }],
          [
            'create',
            {
              agent: 'laborer',
              id: 'session-1',
              model: { modelID: 'gpt-5.6-sol', providerID: 'openai' },
              workingDirectory: '/repo/worktree',
            },
          ],
          ['get', { sessionId: 'session-1' }],
          [
            'messages',
            {
              limit: OPENCODE_MAX_SESSION_MESSAGES,
              order: 'desc',
              sessionId: 'session-1',
              workingDirectory: '/repo/worktree',
            },
          ],
          ['wait', { sessionId: 'session-1' }],
          [
            'messages',
            {
              limit: OPENCODE_MAX_SESSION_MESSAGES,
              order: 'desc',
              sessionId: 'session-1',
              workingDirectory: '/repo/worktree',
            },
          ],
          [
            'messages',
            {
              limit: OPENCODE_MAX_SESSION_MESSAGES,
              order: 'desc',
              sessionId: 'session-1',
              workingDirectory: '/repo/worktree',
            },
          ],
          ['interrupt', { sessionId: 'session-1' }],
        ])
      })
  )
})
