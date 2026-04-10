import type { RpcClient } from '@effect/rpc'
import { Duration, Effect, Exit, ManagedRuntime, Scope, Stream } from 'effect'
import type { DurationInput } from 'effect/Duration'
import type { CloseableScope } from 'effect/Scope'

import {
  createWsRpcProtocolLayer,
  makeWsRpcProtocolClient,
  type WsRpcProtocolClient,
} from '@/rpc/protocol'

interface SubscribeOptions {
  readonly retryDelay?: DurationInput
}

const DEFAULT_SUBSCRIPTION_RETRY_DELAY = Duration.millis(250)

export class WsTransport {
  private readonly runtime: ManagedRuntime.ManagedRuntime<
    RpcClient.Protocol,
    never
  >
  private readonly clientScope: CloseableScope
  private readonly clientPromise: Promise<WsRpcProtocolClient>
  private disposed = false

  constructor(url?: string) {
    this.runtime = ManagedRuntime.make(createWsRpcProtocolLayer(url))
    this.clientScope = this.runtime.runSync(Scope.make())
    this.clientPromise = this.runtime.runPromise(
      Scope.extend(makeWsRpcProtocolClient, this.clientScope)
    )
  }

  async request<TSuccess>(
    execute: (
      client: WsRpcProtocolClient
    ) => Effect.Effect<TSuccess, Error, never>
  ): Promise<TSuccess> {
    if (this.disposed) {
      throw new Error('Transport disposed')
    }

    const client = await this.clientPromise
    return await this.runtime.runPromise(Effect.suspend(() => execute(client)))
  }

  async requestStream<TValue>(
    connect: (
      client: WsRpcProtocolClient
    ) => Stream.Stream<TValue, Error, never>,
    listener: (value: TValue) => void
  ): Promise<void> {
    if (this.disposed) {
      throw new Error('Transport disposed')
    }

    const client = await this.clientPromise
    await this.runtime.runPromise(
      Stream.runForEach(connect(client), (value) =>
        Effect.sync(() => {
          try {
            listener(value)
          } catch {
            // Keep the stream alive if the consumer throws.
          }
        })
      )
    )
  }

  subscribe<TValue>(
    connect: (
      client: WsRpcProtocolClient
    ) => Stream.Stream<TValue, Error, never>,
    listener: (value: TValue) => void,
    options?: SubscribeOptions
  ): () => void {
    if (this.disposed) {
      return () => undefined
    }

    let active = true
    const retryDelay = options?.retryDelay ?? DEFAULT_SUBSCRIPTION_RETRY_DELAY
    const cancel = this.runtime.runCallback(
      Effect.promise(() => this.clientPromise).pipe(
        Effect.flatMap((client) =>
          Stream.runForEach(connect(client), (value) =>
            Effect.sync(() => {
              if (!active) {
                return
              }

              try {
                listener(value)
              } catch {
                // Keep the subscription alive if the consumer throws.
              }
            })
          )
        ),
        Effect.catchAll(() => {
          if (!active || this.disposed) {
            return Effect.interrupt
          }

          return Effect.sleep(retryDelay)
        }),
        Effect.forever
      )
    )

    return () => {
      active = false
      cancel()
    }
  }

  async dispose() {
    if (this.disposed) {
      return
    }

    this.disposed = true
    await this.runtime
      .runPromise(Scope.close(this.clientScope, Exit.void))
      .finally(() => {
        this.runtime.dispose()
      })
  }
}
