import type { PtyHostMethod } from './pty-host-protocol.js'

export interface PtyHostLifecycleGate {
  readonly run: <A>(
    method: PtyHostMethod,
    operation: () => Promise<A>,
    isShutdownAccepted?: (value: A) => boolean
  ) => Promise<A>
}

/** Serializes host shutdown admission against terminal creation across sockets. */
export const makePtyHostLifecycleGate = (): PtyHostLifecycleGate => {
  let lane = Promise.resolve()
  let shutdownAccepted = false

  return {
    run: <A>(
      method: PtyHostMethod,
      operation: () => Promise<A>,
      isShutdownAccepted?: (value: A) => boolean
    ): Promise<A> => {
      if (
        method !== 'spawn' &&
        method !== 'restart' &&
        method !== 'shutdownIfEmpty'
      ) {
        return operation()
      }

      const result = lane.then(async () => {
        if ((method === 'spawn' || method === 'restart') && shutdownAccepted) {
          throw new Error('PTY host shutdown has already been accepted')
        }
        const value = await operation()
        if (
          method === 'shutdownIfEmpty' &&
          isShutdownAccepted?.(value) === true
        ) {
          shutdownAccepted = true
        }
        return value
      })
      lane = result.then(
        () => undefined,
        () => undefined
      )
      return result
    },
  }
}
