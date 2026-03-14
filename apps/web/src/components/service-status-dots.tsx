/**
 * ServiceStatusDots — renders compact status dots in the header,
 * one per core service (Server, Terminal, File Watcher), each showing
 * a colored dot indicating the live status of that service.
 *
 * Consumes `useServiceStatus()` for reactive per-service health states.
 * MCP is excluded from primary indicators (it's not a core service).
 *
 * @see apps/web/src/hooks/use-service-status.ts — per-service status hook
 * @see apps/web/src/lib/sidecar-statuses.ts — pure derivation logic
 * @see Issue #8: Header per-service status dots
 */

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { type ServiceName, useServiceStatus } from '@/hooks/use-service-status'
import {
  getStatusColor,
  getStatusLabel,
  type ServiceState,
  type StatusColor,
} from '@/lib/sidecar-statuses'
import { cn } from '@/lib/utils'

/** Core services shown as status dots (excludes MCP and sync). */
const STATUS_DOT_SERVICES: readonly ServiceName[] = [
  'server',
  'terminal',
  'file-watcher',
] as const

/** Human-readable display names for service status dots. */
const DOT_DISPLAY_NAMES: Record<ServiceName, string> = {
  server: 'Server',
  terminal: 'Terminal',
  'file-watcher': 'File Watcher',
  mcp: 'MCP',
  sync: 'Sync',
}

/** Map semantic colors to Tailwind utility classes for the status dot. */
const DOT_COLOR_CLASSES: Record<StatusColor, string> = {
  green: 'bg-success',
  yellow: 'bg-warning',
  red: 'bg-destructive',
  gray: 'bg-muted-foreground',
}

/** Whether a service state should pulse the indicator dot. */
function shouldPulse(state: ServiceState): boolean {
  return state.state === 'starting' || state.state === 'restarting'
}

/** A single compact status dot with a tooltip showing service name and state. */
function ServiceDot({
  name,
  serviceState,
}: {
  readonly name: ServiceName
  readonly serviceState: ServiceState
}) {
  const color = getStatusColor(serviceState)
  const displayName = DOT_DISPLAY_NAMES[name]
  const label = getStatusLabel(serviceState)
  const pulsing = shouldPulse(serviceState)

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className="inline-flex items-center justify-center p-1"
            data-state={serviceState.state}
            data-testid={`service-dot-${name}`}
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
      </TooltipTrigger>
      <TooltipContent>
        {displayName} — {label}
      </TooltipContent>
    </Tooltip>
  )
}

/** Compact row of status dots for core services. */
function ServiceStatusDots() {
  const statuses = useServiceStatus()

  return (
    <output aria-label="Service statuses" className="flex items-center gap-0.5">
      {STATUS_DOT_SERVICES.map((name) => (
        <ServiceDot key={name} name={name} serviceState={statuses[name]} />
      ))}
    </output>
  )
}

export { ServiceStatusDots, STATUS_DOT_SERVICES }
