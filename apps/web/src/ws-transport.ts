/** biome-ignore-all lint: generic rpc transport helpers require effect-heavy typing. */
import type { RpcClient } from '@effect/rpc'
import {
  Duration,
  Effect,
  Exit,
  ManagedRuntime,
  Match,
  Scope,
  Stream,
} from 'effect'
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
type RequestEffect = Effect.Effect<unknown, unknown, never>

const notifyListener = <TValue>(
  listener: (value: TValue) => void,
  value: TValue
) =>
  Effect.try({
    try: () => listener(value),
    catch: (error) => error,
  }).pipe(Effect.ignore)

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

  async request<TRequest extends RequestEffect>(
    execute: (client: WsRpcProtocolClient) => TRequest
  ): Promise<Effect.Effect.Success<TRequest>> {
    await this.ensureOpen()
    const client = await this.clientPromise

    return await this.runRequest(execute(client))
  }

  async requestStream<TValue>(
    connect: (
      client: WsRpcProtocolClient
    ) => Stream.Stream<TValue, Error, never>,
    listener: (value: TValue) => void
  ): Promise<void> {
    await this.ensureOpen()
    const client = await this.clientPromise
    await this.runtime.runPromise(
      Stream.runForEach(connect(client), (value) =>
        notifyListener(listener, value)
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
    return Match.value(this.disposed).pipe(
      Match.when(true, () => () => undefined),
      Match.orElse(() => this.startSubscription(connect, listener, options))
    )
  }

  private startSubscription<TValue>(
    connect: (
      client: WsRpcProtocolClient
    ) => Stream.Stream<TValue, Error, never>,
    listener: (value: TValue) => void,
    options?: SubscribeOptions
  ) {
    let active = true
    const retryDelay = options?.retryDelay ?? DEFAULT_SUBSCRIPTION_RETRY_DELAY
    const cancel = this.runtime.runCallback(
      Effect.promise(() => this.clientPromise).pipe(
        Effect.flatMap((client) =>
          Stream.runForEach(connect(client), (value) =>
            Effect.when(notifyListener(listener, value), () => active)
          )
        ),
        Effect.catchAll(() => this.retrySubscription(active, retryDelay)),
        Effect.forever
      )
    )

    return () => {
      active = false
      cancel()
    }
  }

  async dispose() {
    await Match.value(this.disposed).pipe(
      Match.when(true, () => Promise.resolve()),
      Match.orElse(() => this.disposeRuntime())
    )
  }

  private ensureOpen() {
    return Match.value(this.disposed).pipe(
      Match.when(true, () => Promise.reject(new Error('Transport disposed'))),
      Match.orElse(() => Promise.resolve())
    )
  }

  private runRequest<TRequest extends RequestEffect>(request: TRequest) {
    return this.runtime.runPromise(request as never) as Promise<
      Effect.Effect.Success<TRequest>
    >
  }

  private disposeRuntime() {
    this.disposed = true
    return this.runtime
      .runPromise(Scope.close(this.clientScope, Exit.void))
      .finally(() => {
        this.runtime.dispose()
      })
  }

  private retrySubscription(active: boolean, retryDelay: DurationInput) {
    return Match.value(active && !this.disposed).pipe(
      Match.when(true, () => Effect.sleep(retryDelay)),
      Match.orElse(() => Effect.interrupt)
    )
  }
}
