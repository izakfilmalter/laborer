import type {
  ServerConfig,
  ServerConfigStreamEvent,
  ServerLifecycleWelcomePayload,
} from '@laborer/contracts/server'

import type { WsRpcClient } from '@/ws-rpc-client'
import {
  makeAppStateAtom,
  readAppStateAtom,
  useAppStateValue,
  writeAppStateAtom,
} from './atom-registry'

type ServerStateClient = Pick<
  WsRpcClient['server'],
  'getConfig' | 'subscribeConfig' | 'subscribeLifecycle'
>

const makeStateAtom = <Value>(label: string, initialValue: Value) =>
  makeAppStateAtom(label, initialValue)

export const welcomeAtom = makeStateAtom<ServerLifecycleWelcomePayload | null>(
  'server-welcome',
  null
)
export const serverConfigAtom = makeStateAtom<ServerConfig | null>(
  'server-config',
  null
)

export function getServerWelcome(): ServerLifecycleWelcomePayload | null {
  return readAppStateAtom(welcomeAtom)
}

export function getServerConfig(): ServerConfig | null {
  return readAppStateAtom(serverConfigAtom)
}

export function applyServerConfigEvent(event: ServerConfigStreamEvent): void {
  if (event.type === 'snapshot') {
    writeAppStateAtom(serverConfigAtom, event.config)
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
        writeAppStateAtom(welcomeAtom, event.payload)
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

        writeAppStateAtom(serverConfigAtom, config)
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
  return useAppStateValue(serverConfigAtom)
}

export function useServerWelcome(): ServerLifecycleWelcomePayload | null {
  return useAppStateValue(welcomeAtom)
}
