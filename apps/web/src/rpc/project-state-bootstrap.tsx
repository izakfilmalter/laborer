import { useEffect } from 'react'

import { getWsRpcClient } from '@/ws-rpc-client'
import { startProjectsStateSync } from './project-state'

export function ProjectsStateBootstrap() {
  useEffect(() => startProjectsStateSync(getWsRpcClient().projects), [])

  return null
}
