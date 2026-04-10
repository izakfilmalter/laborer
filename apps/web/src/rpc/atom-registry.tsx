import type { ReactNode } from 'react'
import { useSyncExternalStore } from 'react'

type Listener = () => void

export interface AppStateAtom<Value> {
  get(): Value
  readonly label: string
  reset(): void
  set(value: Value): void
  subscribe(listener: Listener): () => void
}

const appAtoms = new Set<AppStateAtom<unknown>>()

export const makeAppStateAtom = <Value,>(
  label: string,
  initialValue: Value
): AppStateAtom<Value> => {
  let value = initialValue
  const listeners = new Set<Listener>()

  const notify = () => {
    for (const listener of listeners) {
      listener()
    }
  }

  const atom: AppStateAtom<Value> = {
    label,
    get: () => value,
    set: (nextValue) => {
      if (Object.is(value, nextValue)) {
        return
      }

      value = nextValue
      notify()
    },
    subscribe: (listener) => {
      listeners.add(listener)

      return () => {
        listeners.delete(listener)
      }
    },
    reset: () => {
      value = initialValue
      notify()
    },
  }

  appAtoms.add(atom as AppStateAtom<unknown>)

  return atom
}

export const readAppStateAtom = <Value,>(atom: AppStateAtom<Value>): Value =>
  atom.get()

export const writeAppStateAtom = <Value,>(
  atom: AppStateAtom<Value>,
  value: Value
): void => {
  atom.set(value)
}

export const useAppStateValue = <Value,>(atom: AppStateAtom<Value>): Value =>
  useSyncExternalStore(atom.subscribe, atom.get, atom.get)

export function AppAtomRegistryProvider({
  children,
}: {
  readonly children: ReactNode
}) {
  return children
}

export function resetAppAtomRegistryForTests() {
  for (const atom of appAtoms) {
    atom.reset()
  }
}
