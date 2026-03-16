/**
 * DockerStatusBanner — Warning banner when Docker is unavailable
 *
 * Queries the `docker.status` RPC on mount. When Docker is unavailable,
 * renders a persistent warning banner with the error message and a link
 * to install OrbStack.
 *
 * Issue 2: Docker prerequisite detection
 */

import { useAtomValue } from '@effect-atom/atom-react/Hooks'
import { AlertTriangle } from 'lucide-react'
import { Suspense } from 'react'
import { LaborerClient } from '@/atoms/laborer-client'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'

// biome-ignore lint/suspicious/noConfusingVoidType: Effect RPC uses void for empty payloads
const dockerStatus$ = LaborerClient.query('docker.status', undefined as void)

function DockerStatusContent() {
  const result = useAtomValue(dockerStatus$)

  // Still loading or waiting for response
  if (result._tag === 'Initial' || result.waiting) {
    return null
  }

  // RPC call failed — don't show banner (server might be down, health check handles that)
  if (result._tag === 'Failure') {
    return null
  }

  // Docker is available — no banner needed
  if (result.value.available) {
    return null
  }

  return (
    <Alert variant="destructive">
      <AlertTriangle className="size-3.5" />
      <AlertTitle>Docker not available</AlertTitle>
      <AlertDescription>
        {result.value.error ?? 'Docker is not available on this system.'}{' '}
        <a
          className="font-medium underline underline-offset-4"
          href="https://orbstack.dev"
          rel="noopener noreferrer"
          target="_blank"
        >
          Install OrbStack
        </a>
      </AlertDescription>
    </Alert>
  )
}

function DockerStatusBanner() {
  return (
    <Suspense fallback={null}>
      <DockerStatusContent />
    </Suspense>
  )
}

export { DockerStatusBanner }
