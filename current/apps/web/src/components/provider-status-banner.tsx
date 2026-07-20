/**
 * ProviderStatusBanner — Warning banner when the sandbox provider is unavailable
 *
 * Queries the `sandbox.providerStatus` RPC on mount. When the configured
 * sandbox provider (Docker or Daytona) is unavailable, renders a persistent
 * warning banner with the error message and provider-specific guidance.
 *
 * Issue 2: Docker prerequisite detection
 * Issue 4: UI update to provider-agnostic naming
 * Issue 12: Daytona availability check + Daytona-specific guidance
 */

import { useAtomValue } from '@effect-atom/atom-react/Hooks'
import { AlertTriangle } from 'lucide-react'
import { Suspense } from 'react'
import { LaborerClient } from '@/atoms/laborer-client'
import { LifecyclePhase } from '@/components/lifecycle-phase-context'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { useWhenPhase } from '@/hooks/use-when-phase'

const providerStatus$ = LaborerClient.query(
  'sandbox.providerStatus',
  // biome-ignore lint/suspicious/noConfusingVoidType: Effect RPC uses void for empty payloads
  undefined as void
)

/**
 * Detect whether the error message indicates a Daytona-specific issue.
 * Used to render provider-appropriate guidance links.
 */
const isDaytonaError = (error: string | undefined): boolean =>
  error !== undefined &&
  (error.includes('Daytona') || error.includes('DAYTONA_API_KEY'))

function ProviderStatusContent() {
  const result = useAtomValue(providerStatus$)

  // Still loading or waiting for response
  if (result._tag === 'Initial' || result.waiting) {
    return null
  }

  // RPC call failed — don't show banner (server might be down, health check handles that)
  if (result._tag === 'Failure') {
    return null
  }

  // Provider is available — no banner needed
  if (result.value.available) {
    return null
  }

  const errorMessage =
    result.value.error ??
    'The sandbox provider is not available on this system.'
  const isDaytona = isDaytonaError(result.value.error)

  return (
    <Alert variant="destructive">
      <AlertTriangle className="size-3.5" />
      <AlertTitle>Sandbox provider not available</AlertTitle>
      <AlertDescription>
        {errorMessage}{' '}
        {isDaytona ? (
          <a
            className="font-medium underline underline-offset-4"
            href="https://app.daytona.io/dashboard/keys"
            rel="noopener noreferrer"
            target="_blank"
          >
            Manage Daytona API keys
          </a>
        ) : (
          <a
            className="font-medium underline underline-offset-4"
            href="https://orbstack.dev"
            rel="noopener noreferrer"
            target="_blank"
          >
            Install OrbStack
          </a>
        )}
      </AlertDescription>
    </Alert>
  )
}

/**
 * Provider status banner — only queries the server and renders after Phase 4
 * (Eventually) when deferred services (including the sandbox provider) are ready.
 * Before Phase 4, renders nothing — the sandbox.providerStatus RPC would return a
 * SERVICE_INITIALIZING error anyway.
 *
 * @see Issue #12: Progressive feature enablement for Phases 3-4
 */
function ProviderStatusBanner() {
  const isEventually = useWhenPhase(LifecyclePhase.Eventually)

  if (!isEventually) {
    return null
  }

  return (
    <Suspense fallback={null}>
      <ProviderStatusContent />
    </Suspense>
  )
}

export { ProviderStatusBanner }
