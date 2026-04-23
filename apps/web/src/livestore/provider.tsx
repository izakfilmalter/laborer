/**
 * LiveStore React provider component for the Laborer app.
 *
 * Wraps the app tree with `StoreRegistryProvider` and a `Suspense`
 * boundary. The `StoreRegistry` manages LiveStore lifecycle (loading,
 * retaining, releasing stores) across the component tree.
 *
 * Components inside this provider can call `useLaborerStore()` to get
 * a fully initialized store instance with reactive query hooks.
 *
 * @see apps/web/src/livestore/store.ts for the store setup
 * @see Issue #17: LiveStore client adapter setup
 */

import { StoreRegistry } from '@livestore/livestore'
import { StoreRegistryProvider } from '@livestore/react'
import { Component, Suspense, useEffect, useState } from 'react'

import Loader from '@/components/loader'
import {
  isRecoverablePersistenceError,
  schedulePersistenceResetRecovery,
} from '@/livestore/recovery'

class LiveStoreBootBoundary extends Component<
  { children: React.ReactNode },
  { hasError: boolean }
> {
  override state = { hasError: false }

  static getDerivedStateFromError(): { hasError: boolean } {
    return { hasError: true }
  }

  override componentDidCatch(error: unknown) {
    const cause =
      error instanceof Error
        ? `${error.message}\n${error.stack ?? ''}`
        : String(error)

    if (
      isRecoverablePersistenceError(cause) &&
      schedulePersistenceResetRecovery()
    ) {
      console.warn(
        '[LiveStoreProvider] Recoverable LiveStore boot error detected — reloading once with a cleared local cache'
      )
      globalThis.location.reload()
      return
    }

    console.error('[LiveStoreProvider] LiveStore boot failed', error)
  }

  override render() {
    if (this.state.hasError) {
      return <Loader />
    }

    return this.props.children
  }
}

const LiveStoreProvider = ({ children }: { children: React.ReactNode }) => {
  const [storeRegistry] = useState(() => new StoreRegistry())

  useEffect(() => {
    return () => {
      const disposableStoreRegistry = storeRegistry as StoreRegistry & {
        dispose?: () => Promise<void>
      }

      disposableStoreRegistry.dispose?.().catch((error: unknown) => {
        console.warn(
          '[LiveStoreProvider] Failed to dispose StoreRegistry during unmount',
          error
        )
      })
    }
  }, [storeRegistry])

  return (
    <StoreRegistryProvider storeRegistry={storeRegistry}>
      <LiveStoreBootBoundary>
        <Suspense fallback={<Loader />}>{children}</Suspense>
      </LiveStoreBootBoundary>
    </StoreRegistryProvider>
  )
}

export { LiveStoreProvider }
