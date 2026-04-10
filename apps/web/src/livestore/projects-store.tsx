import {
  PROJECTS_LIVESTORE_ID,
  projectStoreSchema,
} from '@laborer/contracts/livestore'

import { makePersistedAdapter } from '@livestore/adapter-web'
import LiveStoreSharedWorker from '@livestore/adapter-web/shared-worker?sharedworker'
import { type Store, StoreRegistry, storeOptions } from '@livestore/livestore'
import {
  type ReactApi,
  StoreRegistryProvider,
  useStore,
} from '@livestore/react'
import { type ReactNode, Suspense, useState } from 'react'
import { unstable_batchedUpdates as batchUpdates } from 'react-dom'

import Loader from '@/components/loader'
import LiveStoreWorker from '@/livestore.worker.ts?worker'

const adapter = makePersistedAdapter({
  storage: { type: 'opfs' },
  worker: LiveStoreWorker,
  sharedWorker: LiveStoreSharedWorker,
})

const projectsStoreOptions = storeOptions({
  adapter,
  batchUpdates,
  schema: projectStoreSchema,
  storeId: PROJECTS_LIVESTORE_ID,
})

type ProjectsStore = Store<typeof projectStoreSchema> & ReactApi

let sharedProjectsStore: ProjectsStore | null = null

export function useProjectsStore(): ProjectsStore {
  return useStore(projectsStoreOptions)
}

export function getLoadedProjectsStore(): ProjectsStore | null {
  return sharedProjectsStore
}

export function setLoadedProjectsStore(store: ProjectsStore): void {
  sharedProjectsStore = store
}

export function clearLoadedProjectsStore(store: ProjectsStore): void {
  if (sharedProjectsStore === store) {
    sharedProjectsStore = null
  }
}

export function ProjectsStoreProvider({
  children,
}: {
  readonly children: ReactNode
}) {
  const [storeRegistry] = useState(() => new StoreRegistry())

  return (
    <Suspense fallback={<Loader />}>
      <StoreRegistryProvider storeRegistry={storeRegistry}>
        {children}
      </StoreRegistryProvider>
    </Suspense>
  )
}
