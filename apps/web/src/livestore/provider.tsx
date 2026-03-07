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
import { Suspense, useState } from 'react'

import Loader from '@/components/loader'

const LiveStoreProvider = ({ children }: { children: React.ReactNode }) => {
  const [storeRegistry] = useState(() => new StoreRegistry())

  return (
    <StoreRegistryProvider storeRegistry={storeRegistry}>
      <Suspense fallback={<Loader />}>{children}</Suspense>
    </StoreRegistryProvider>
  )
}

export { LiveStoreProvider }
