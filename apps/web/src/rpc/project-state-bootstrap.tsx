import { useEffect } from 'react'

import {
  clearLoadedProjectsStore,
  setLoadedProjectsStore,
  useProjectsStore,
} from '@/livestore/projects-store'
import { getWsRpcClient } from '@/ws-rpc-client'
import { startProjectsStateSync } from './project-state'

export function ProjectsStateBootstrap() {
  const store = useProjectsStore()

  useEffect(() => {
    setLoadedProjectsStore(store)
    const cleanup = startProjectsStateSync(getWsRpcClient().projects)

    return () => {
      cleanup()
      clearLoadedProjectsStore(store)
    }
  }, [store])

  return null
}
