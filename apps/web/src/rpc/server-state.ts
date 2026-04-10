import { useAtomValue } from '@effect/atom-react'
import type {
  ServerConfig,
  ServerConfigStreamEvent,
  ServerLifecycleWelcomePayload,
} from '@laborer/contracts/server'
import { Atom } from 'effect/unstable/reactivity'

import type { WsRpcClient } from '@/ws-rpc-client'
import { appAtomRegistry } from './atom-registry'

type ServerStateClient = Pick<
  WsRpcClient['server'],
  'getConfig' | 'subscribeConfig' | 'subscribeLifecycle'
>

const makeStateAtom = <Value>(label: string, initialValue: Value) =>
  Atom.make(initialValue).pipe(Atom.keepAlive, Atom.withLabel(label))

export const welcomeAtom = makeStateAtom<ServerLifecycleWelcomePayload | null>(
  'server-welcome',
  null
)
export const serverConfigAtom = makeStateAtom<ServerConfig | null>(
  'server-config',
  null
)

export function getServerWelcome(): ServerLifecycleWelcomePayload | null {
  return appAtomRegistry.get(welcomeAtom)
}

export function getServerConfig(): ServerConfig | null {
  return appAtomRegistry.get(serverConfigAtom)
}

export function applyServerConfigEvent(event: ServerConfigStreamEvent): void {
  if (event.type === 'snapshot') {
    appAtomRegistry.set(serverConfigAtom, event.config)
  }
}

export function startServerStateSync(client: ServerStateClient): () => void {
  let disposed = false
  const cleanups = [
    client.subscribeConfig((event) => {
      applyServerConfigEvent(event)
    }),
    client.subscribeLifecycle((event) => {
      if (event.type === 'welcome') {
        appAtomRegistry.set(welcomeAtom, event.payload)
      }
    }),
  ]

  if (getServerConfig() === null) {
    client
      .getConfig()
      .then((config) => {
        if (disposed || getServerConfig() !== null) {
          return
        }

        appAtomRegistry.set(serverConfigAtom, config)
      })
      .catch(() => undefined)
  }

  return () => {
    disposed = true
    for (const cleanup of cleanups) {
      cleanup()
    }
  }
}

export function useServerConfig(): ServerConfig | null {
  return useAtomValue(serverConfigAtom)
}

export function useServerWelcome(): ServerLifecycleWelcomePayload | null {
  return useAtomValue(welcomeAtom)
}
