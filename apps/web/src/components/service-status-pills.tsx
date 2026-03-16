/**
 * ServiceStatusPills — renders a row of small pills in the header,
 * one per sidecar service, each showing a colored dot and service name
 * to indicate the live status of that service.
 *
 * @see apps/web/src/hooks/use-sidecar-statuses.ts — live status hook
 * @see apps/web/src/lib/sidecar-statuses.ts — pure derivation logic
 */

import type { SidecarName } from '@laborer/shared/desktop-bridge'

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { useSidecarStatuses } from '@/hooks/use-sidecar-statuses'
import {
  ALL_SIDECAR_NAMES,
  getDisplayName,
  getStatusColor,
  getStatusLabel,
  type ServiceState,
  type StatusColor,
} from '@/lib/sidecar-statuses'
import { cn } from '@/lib/utils'

/** Map semantic colors to Tailwind utility classes for the status dot. */
const DOT_COLOR_CLASSES: Record<StatusColor, string> = {
  green: 'bg-success',
  yellow: 'bg-warning',
  red: 'bg-destructive',
  gray: 'bg-muted-foreground',
}

/** Map semantic colors to text color classes for the label. */
const TEXT_COLOR_CLASSES: Record<StatusColor, string> = {
  green: 'text-success',
  yellow: 'text-warning',
  red: 'text-destructive',
  gray: 'text-muted-foreground',
}

/** Map semantic colors to border color classes for the pill. */
const BORDER_COLOR_CLASSES: Record<StatusColor, string> = {
  green: 'border-success/40',
  yellow: 'border-warning/40',
  red: 'border-destructive/40',
  gray: 'border-border',
}

/** Whether a service state should pulse the indicator dot. */
function shouldPulse(state: ServiceState): boolean {
  return state.state === 'starting' || state.state === 'restarting'
}

/** A single service status pill with a colored dot, name, and tooltip. */
function ServicePill({
  name,
  serviceState,
}: {
  readonly name: SidecarName
  readonly serviceState: ServiceState
}) {
  const color = getStatusColor(serviceState)
  const displayName = getDisplayName(name)
  const label = getStatusLabel(serviceState)
  const pulsing = shouldPulse(serviceState)

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className={cn(
              'inline-flex items-center gap-1.5 border px-2 py-0.5 text-xs',
              TEXT_COLOR_CLASSES[color],
              BORDER_COLOR_CLASSES[color]
            )}
            data-testid={`service-pill-${name}`}
          />
        }
      >
        <span aria-hidden="true" className="relative inline-flex size-2">
          {pulsing && (
            <span
              className={cn(
                'absolute inline-flex size-full animate-ping rounded-full opacity-75',
                DOT_COLOR_CLASSES[color]
              )}
            />
          )}
          <span
            className={cn(
              'relative inline-flex size-2 rounded-full',
              DOT_COLOR_CLASSES[color]
            )}
          />
        </span>
        {displayName}
      </TooltipTrigger>
      <TooltipContent>
        {displayName} — {label}
      </TooltipContent>
    </Tooltip>
  )
}

/** Row of service status pills for all sidecar services. */
function ServiceStatusPills() {
  const statuses = useSidecarStatuses()

  return (
    <output aria-label="Service statuses" className="flex items-center gap-1">
      {ALL_SIDECAR_NAMES.map((name) => (
        <ServicePill key={name} name={name} serviceState={statuses[name]} />
      ))}
    </output>
  )
}

export { ServiceStatusPills }
