import { describe, expect, it } from 'vitest'
import { Effect, Option, Stream } from 'effect'
import type { RpcMessagePort } from '@laborer/shared/rpc-transport-messageport'
import { makeMessagePortSync } from '@/livestore/messageport-sync'

const makeFakePort = () => {
  const postedMessages: unknown[] = []

  const port: RpcMessagePort = {
    close: () => {},
    onclose: null,
    onmessage: null,
    postMessage: (value) => {
      postedMessages.push(value)
    },
    start: () => {},
  }

  return { port, postedMessages }
}

const isPullRequest = (value: unknown): boolean => {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  const message = value as {
    _tag?: string
    tag?: string
  }

  return message._tag === 'Request' && message.tag === 'SyncWsRpc.Pull'
}

describe('makeMessagePortSync', () => {
  it('does not send a preflight pull during connect', async () => {
    const { port, postedMessages } = makeFakePort()

    const pullRequestCount = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const syncBackend = yield* makeMessagePortSync(port)({
            clientId: 'renderer-1',
            payload: undefined,
            storeId: 'laborer',
          })

          yield* syncBackend.connect

          return postedMessages.filter(isPullRequest).length
        })
      )
    )

    expect(pullRequestCount).toBe(0)
  })

  it('only sends the real live pull on initial boot', async () => {
    const { port, postedMessages } = makeFakePort()

    const pullRequestCount = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const syncBackend = yield* makeMessagePortSync(port)({
            clientId: 'renderer-1',
            payload: undefined,
            storeId: 'laborer',
          })

          yield* syncBackend.connect

          yield* Effect.forkScoped(
            Stream.runHead(syncBackend.pull(Option.none(), { live: true }))
          )
          yield* Effect.sleep(10)

          return postedMessages.filter(isPullRequest).length
        })
      )
    )

    expect(pullRequestCount).toBe(1)
  })
})
