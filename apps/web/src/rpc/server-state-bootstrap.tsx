import { useEffect } from 'react'

import { getWsRpcClient } from '@/ws-rpc-client'
import { startServerStateSync } from './server-state'

export function ServerStateBootstrap() {
  useEffect(() => startServerStateSync(getWsRpcClient().server), [])

  return null
}
