import { useAtomValue } from '@effect-atom/atom-react/Hooks'
import { Suspense } from 'react'

import { LaborerClient } from '@/atoms/laborer-client'

// biome-ignore lint/suspicious/noConfusingVoidType: Effect RPC uses void for empty payloads
const healthCheck$ = LaborerClient.query('health.check', undefined as void)

function HealthCheckStatusInner() {
  const result = useAtomValue(healthCheck$)
  if (result._tag === 'Initial' || result.waiting) {
    return <span className="text-muted-foreground">connecting...</span>
  }
  if (result._tag === 'Failure') {
    return <span className="text-destructive">disconnected</span>
  }
  return (
    <span className="text-success">
      connected (uptime: {Math.round(result.value.uptime)}s)
    </span>
  )
}

export function HealthCheckStatus() {
  return (
    <Suspense
      fallback={<span className="text-muted-foreground">loading...</span>}
    >
      <HealthCheckStatusInner />
    </Suspense>
  )
}
