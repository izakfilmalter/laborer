import { assert, describe, it } from '@effect/vitest'
import { openPromptEpochEventStream } from '../src/acp-runtime/prompt-epoch-admission.ts'
import { canComposeWorkspaceWithSupervisorHealth } from '../src/acp-runtime/workspace-runtime.ts'

describe('ACP startup resilience', () => {
  it('acknowledges the prompt epoch before waiting for OpenCode event-stream readiness', async () => {
    const calls: string[] = []
    let releaseReadiness = (): void => undefined
    const readiness = new Promise<void>((resolve) => {
      releaseReadiness = resolve
    })

    const opening = openPromptEpochEventStream({
      publishEpoch: () => {
        calls.push('epoch')
        return Promise.resolve()
      },
      subscribe: () => ({
        next: async () => {
          calls.push('readiness')
          await readiness
          return { done: false as const, value: undefined }
        },
      }),
    })

    await Promise.resolve()
    assert.deepStrictEqual(calls, ['epoch', 'readiness'])
    releaseReadiness()
    await opening
  })

  it('keeps the daemon composition alive for a quarantined workspace', () => {
    assert.strictEqual(
      canComposeWorkspaceWithSupervisorHealth('quarantined'),
      true
    )
  })
})
