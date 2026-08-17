import { Effect, Stream } from 'effect'

import { LaborerClient } from './laborer-client'

/** The decoded Effect RPC stream consumed by the shared collection bundle. */
export const makeSharedStateEventsAtom = () =>
  LaborerClient.runtime.pull(
    LaborerClient.pipe(
      Effect.map((client) =>
        // biome-ignore lint/suspicious/noConfusingVoidType: Effect RPC uses void for empty payloads
        client('state.subscribe', undefined as void)
      ),
      Stream.unwrap,
      Stream.tapError((error) =>
        Effect.logDebug(
          'Shared-state transport closed; awaiting next generation',
          error
        )
      )
    ),
    { disableAccumulation: true }
  )
