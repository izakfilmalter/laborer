import { Badge } from '@/components/ui/badge'
import { localApi } from '@/lib/local-api'

import { LifecyclePhase, useLifecyclePhase } from './lifecycle-phase-context'

const PHASE_NAMES: Record<LifecyclePhase, string> = {
  [LifecyclePhase.Starting]: 'Starting',
  [LifecyclePhase.Ready]: 'Ready',
  [LifecyclePhase.Restored]: 'Restored',
  [LifecyclePhase.Eventually]: 'Eventually',
}

function PhaseIndicator() {
  const { phase } = useLifecyclePhase()
  const name = PHASE_NAMES[phase]

  // Hide once everything is fully loaded
  if (phase === LifecyclePhase.Eventually) {
    return null
  }

  return (
    <Badge className="text-muted-foreground" variant="outline">
      Phase: {name}
    </Badge>
  )
}

export default function Header() {
  const electron = localApi.isDesktop

  return (
    <div className={electron ? 'drag-region' : undefined}>
      <div
        className={`flex flex-row items-center justify-between px-2 ${
          electron ? 'h-[52px] pl-[80px]' : 'py-1'
        }`}
      >
        <span className="font-medium text-lg">laborer</span>
        <div className="flex items-center gap-2">
          <PhaseIndicator />
        </div>
      </div>
      <hr />
    </div>
  )
}
