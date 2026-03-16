import { useEffect } from 'react'
import {
  LifecyclePhase,
  LifecyclePhaseProvider,
  useLifecyclePhase,
} from '../../src/components/lifecycle-phase-context'

/** Immediately advances to Ready phase on mount. */
export function AdvanceToReady() {
  const { advanceTo } = useLifecyclePhase()
  useEffect(() => {
    advanceTo(LifecyclePhase.Ready)
  }, [advanceTo])
  return null
}

/** Wraps children in a LifecyclePhaseProvider that advances to Ready. */
export function ReadyPhaseWrapper({ children }: { children: React.ReactNode }) {
  return (
    <LifecyclePhaseProvider>
      <AdvanceToReady />
      {children}
    </LifecyclePhaseProvider>
  )
}
