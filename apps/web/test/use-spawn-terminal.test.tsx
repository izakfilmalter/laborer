import { act, cleanup, renderHook } from '@testing-library/react'
import { Context, Effect } from 'effect'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { calls, runtimeResultRef, useAtomMountMock } = vi.hoisted(() => ({
  calls: new Map<
    string,
    { reject: (error: Error) => void; resolve: (id: string) => void }
  >(),
  runtimeResultRef: { current: undefined as unknown },
  useAtomMountMock: vi.fn(),
}))

vi.mock('@effect/atom-react/Hooks', () => ({
  useAtomMount: useAtomMountMock,
  useAtomValue: () => runtimeResultRef.current,
}))

vi.mock('@/atoms/laborer-client', async () => {
  const { Context } = await import('effect')
  return {
    LaborerClient: Context.Service<
      { readonly LaborerClient: unknown },
      unknown
    >('test/LaborerClient'),
  }
})

import { LaborerClient } from '@/atoms/laborer-client'
import { useSpawnTerminal } from '@/hooks/use-spawn-terminal'

describe('useSpawnTerminal', () => {
  afterEach(() => {
    cleanup()
    calls.clear()
  })

  it('runs concurrent spawns independently when one fails', async () => {
    const client = (_tag: string, payload: { readonly workspaceId: string }) =>
      Effect.tryPromise({
        try: () =>
          new Promise((resolve, reject) => {
            calls.set(payload.workspaceId, {
              reject,
              resolve: (id) =>
                resolve({
                  command: '/bin/zsh',
                  id,
                  status: 'running',
                  workspaceId: payload.workspaceId,
                }),
            })
          }),
        catch: (error) =>
          error instanceof Error ? error : new Error(String(error)),
      })
    runtimeResultRef.current = {
      _tag: 'Success',
      value: Context.makeUnsafe(new Map([[LaborerClient.key, client]])),
    }
    const { result } = renderHook(() => useSpawnTerminal())

    const promises = ['a', 'b', 'c'].map((workspaceId) =>
      result.current({ payload: { workspaceId } })
    )
    await act(async () => {
      await Promise.resolve()
    })

    calls.get('b')?.reject(new Error('spawn failed'))
    calls.get('c')?.resolve('terminal-c')
    calls.get('a')?.resolve('terminal-a')

    await expect(Promise.allSettled(promises)).resolves.toMatchObject([
      { status: 'fulfilled', value: { id: 'terminal-a', workspaceId: 'a' } },
      { status: 'rejected' },
      { status: 'fulfilled', value: { id: 'terminal-c', workspaceId: 'c' } },
    ])
  })
})
