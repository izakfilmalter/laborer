import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { assert, describe, it } from '@effect/vitest'
import { Effect } from 'effect'
import {
  makeOpenCodeImplementationAgent,
  makeOpenCodeSessionClientFromV2Api,
  type OpenCodeSessionMessage,
  type OpenCodeV2SessionApi,
} from '../src/adapters/opencode-agents.ts'
import type { ExternalInputEvent } from '../src/application.ts'
import {
  makeFileApplicationRepository,
  makeReferenceCodingApplication,
  WorktreeManager,
} from '../src/reference-coding-application.ts'
import { makeTempDirectoryScoped } from './support/temp-directory.ts'

const acceptedEvent = (event: ExternalInputEvent) =>
  Effect.succeed({
    decision: { _tag: 'Accepted' as const, eventId: event.eventId },
    scheduling: 'AlreadyDurable' as const,
  })

const persistedState = (options: {
  readonly executionId: string
  readonly promptId: string
  readonly schemaVersion: number
  readonly sessionId: string
  readonly workingDirectory: string
}) => ({
  actionOperationTombstones: [],
  actionOperations: [],
  conversationAdoptions: [],
  conversations: [],
  executionEventOutbox: [],
  executionPromptOperations: [],
  executions: [
    {
      actionInvocationId: `operation:${options.schemaVersion}`,
      actionName: 'create-feature',
      attachment: {
        reason: null,
        state: 'attached',
        updatedAt: 1,
      },
      cancellation: null,
      conversationId: `workspace:T240:C240:${options.schemaVersion}`,
      events: [],
      executionId: options.executionId,
      implementationSessionId: options.sessionId,
      ownerWorkspaceId: 'T240',
      prompts: [
        {
          kind: 'initial',
          promptId: options.promptId,
          status: 'running',
          text: 'Recover the persisted request without changing identities.',
        },
      ],
      recoveryFailure: null,
      responses: [],
      status: 'running',
      workingDirectory: options.workingDirectory,
      worktreeName: `permission-cutover-${options.schemaVersion}`,
    },
  ],
  recoveryDecisions: [],
  schemaVersion: options.schemaVersion,
})

describe('OpenCode legacy permission cutover', () => {
  it.effect(
    'recovers v1-v16 Executions with the same IDs after cleanup',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            'laborer-opencode-permission-cutover-'
          )
          for (let schemaVersion = 1; schemaVersion <= 16; schemaVersion += 1) {
            const executionId = `execution:legacy-v${schemaVersion}`
            const promptId = `prompt:legacy-v${schemaVersion}`
            const sessionId = `session:legacy-v${schemaVersion}`
            const workingDirectory = join(root, `worktree-v${schemaVersion}`)
            const statePath = join(root, `application-v${schemaVersion}.json`)
            yield* Effect.promise(() =>
              writeFile(
                statePath,
                JSON.stringify(
                  persistedState({
                    executionId,
                    promptId,
                    schemaVersion,
                    sessionId,
                    workingDirectory,
                  })
                )
              )
            )
            const repository = yield* makeFileApplicationRepository(
              statePath,
              root
            )
            let permission: unknown = [
              { action: 'allow', pattern: '*', permission: '*' },
            ]
            let messages: readonly OpenCodeSessionMessage[] = []
            const createIds: string[] = []
            const promptIdentities: Array<{
              readonly promptId: string
              readonly sessionId: string
              readonly workingDirectory: string
            }> = []
            const updateIds: string[] = []
            const api: OpenCodeV2SessionApi = {
              create: (input) => {
                createIds.push(input.id)
                return Promise.resolve({ id: input.id })
              },
              get: (input) =>
                Promise.resolve({
                  id: input.sessionId,
                  workingDirectory,
                }),
              getPermission: () => Promise.resolve(permission),
              interrupt: () => Promise.resolve(),
              messages: () => Promise.resolve(messages),
              prompt: (input) => {
                promptIdentities.push({
                  promptId: input.promptId,
                  sessionId: input.sessionId,
                  workingDirectory: input.workingDirectory,
                })
                messages = [
                  {
                    finish: 'stop',
                    id: `response:${schemaVersion}`,
                    role: 'assistant',
                    status: 'completed',
                    text: 'Recovered.',
                  },
                  {
                    id: input.promptId,
                    role: 'user',
                    text: input.text,
                  },
                ]
                return Promise.resolve({ id: input.promptId })
              },
              updatePermission: (input) => {
                updateIds.push(input.sessionId)
                permission = input.permission
                return Promise.resolve()
              },
              wait: () => Promise.resolve(),
            }
            const implementationAgent = makeOpenCodeImplementationAgent({
              client: makeOpenCodeSessionClientFromV2Api(api),
            })
            const application = yield* makeReferenceCodingApplication({
              conversationAgent: { handle: () => Effect.succeed([]) },
              implementationAgent,
              repository,
              worktreeManager: WorktreeManager.of({
                create: () =>
                  Effect.die(
                    new Error('must not create a replacement worktree')
                  ),
                inspect: () =>
                  Effect.succeed({
                    certainty: 'definitive',
                    evidence: 'exact-owned-resource',
                    resource: { workingDirectory },
                    status: 'available',
                  }),
              }),
            })

            yield* application.recover?.(acceptedEvent) ?? Effect.void

            assert.deepStrictEqual(createIds, [])
            assert.deepStrictEqual(updateIds, [sessionId])
            assert.deepStrictEqual(permission, [])
            assert.deepStrictEqual(promptIdentities, [
              { promptId, sessionId, workingDirectory },
            ])
            const recovered = (yield* repository.load).executions[0]
            assert.strictEqual(recovered?.executionId, executionId)
            assert.strictEqual(recovered?.implementationSessionId, sessionId)
            assert.strictEqual(recovered?.prompts[0]?.promptId, promptId)
            assert.strictEqual(recovered?.workingDirectory, workingDirectory)
          }
        })
      ),
    30_000
  )
})
