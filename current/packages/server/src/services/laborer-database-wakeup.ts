import { resolve } from 'node:path'

type Listener = () => void

const listenersByPath = new Map<string, Set<Listener>>()

const keyForPath = (path: string): string =>
  path === ':memory:' ? path : resolve(path)

/**
 * Process-local post-commit signal. It is only a latency optimization: the
 * durable ledgers remain authoritative and the subscription also polls them.
 */
export const notifyLaborerDatabaseWrite = (path: string): void => {
  for (const listener of listenersByPath.get(keyForPath(path)) ?? []) {
    try {
      listener()
    } catch {
      // A wakeup is only a latency hint after the transaction committed. One
      // broken subscriber must not make that durable write appear to fail or
      // prevent the remaining subscribers from observing it.
    }
  }
}

export const onLaborerDatabaseWrite = (
  path: string,
  listener: Listener
): (() => void) => {
  const key = keyForPath(path)
  const listeners = listenersByPath.get(key) ?? new Set<Listener>()
  listeners.add(listener)
  listenersByPath.set(key, listeners)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      listenersByPath.delete(key)
    }
  }
}
