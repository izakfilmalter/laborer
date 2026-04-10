import type { ServerLifecycleStreamEvent } from '@laborer/contracts/server'
import { Context, Effect, Layer, PubSub, Ref, Stream } from 'effect'

import { ServerRuntimeConfig } from './config'

interface SnapshotState {
  readonly events: readonly ServerLifecycleStreamEvent[]
  readonly sequence: number
}

const getSnapshot = (state: Ref.Ref<SnapshotState>) => Ref.get(state)

const streamLifecycleEvents = (
  pubsub: PubSub.PubSub<ServerLifecycleStreamEvent>
) => Stream.fromPubSub(pubsub)

export interface ServerLifecycleEventsShape {
  readonly snapshot: ReturnType<typeof getSnapshot>
  readonly stream: ReturnType<typeof streamLifecycleEvents>
}

export class ServerLifecycleEvents extends Context.Tag(
  '@laborer/server/ServerLifecycleEvents'
)<ServerLifecycleEvents, ServerLifecycleEventsShape>() {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const config = yield* ServerRuntimeConfig
      const pubsub = yield* PubSub.unbounded<ServerLifecycleStreamEvent>()
      const initialEvents = [
        {
          version: 1,
          sequence: 1,
          type: 'welcome' as const,
          payload: {
            cwd: config.cwd,
            projectName: config.projectName,
          },
        },
        {
          version: 1,
          sequence: 2,
          type: 'ready' as const,
          payload: {
            at: new Date().toISOString(),
          },
        },
      ] satisfies readonly ServerLifecycleStreamEvent[]
      const state = yield* Ref.make<SnapshotState>({
        events: initialEvents,
        sequence: 2,
      })

      return ServerLifecycleEvents.of({
        snapshot: getSnapshot(state),
        stream: streamLifecycleEvents(pubsub),
      })
    })
  )
}
