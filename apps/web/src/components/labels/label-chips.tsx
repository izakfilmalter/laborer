/**
 * How a label reads on a task surface.
 *
 * One or two labels are worth naming; beyond that the names crowd out the
 * card's title, so the chips collapse into an overlapping dot cluster and a
 * count. Every surface uses the same thresholds so a card looks the same in
 * the board, the sidebar, and the detail dialog.
 */

import { Tag } from 'lucide-react'
import type { ComponentPropsWithRef, ReactElement } from 'react'

import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

import { labelDotClassName } from './label-colors'

/** A label as the pickers and chips consume it. */
export interface TaskLabelOption {
  readonly color: string
  readonly id: string
  readonly name: string
}

/** Where naming every label stops fitting beside a card title. */
const NAMED_CHIP_LIMIT = 2

export function LabelDot({
  label,
  className,
}: {
  readonly className?: string
  readonly label: TaskLabelOption
}): ReactElement {
  return (
    <span
      className={cn('size-2 rounded-full', labelDotClassName(label), className)}
    />
  )
}

/**
 * The read-only chips a card shows. With no labels this renders nothing —
 * only interactive surfaces earn an empty "add labels" affordance.
 */
export function TaskLabelsBadge({
  labels,
  className,
}: {
  readonly className?: string
  readonly labels: readonly TaskLabelOption[]
}): ReactElement | null {
  if (labels.length === 0) {
    return null
  }
  if (labels.length <= NAMED_CHIP_LIMIT) {
    return (
      <span className={cn('flex min-w-0 items-center gap-1', className)}>
        {labels.map((label) => (
          <Badge
            className="max-w-32 gap-1.5 text-muted-foreground"
            key={label.id}
            variant="outline"
          >
            <LabelDot label={label} />
            <span className="truncate">{label.name}</span>
          </Badge>
        ))}
      </span>
    )
  }
  return (
    <Badge
      className={cn('gap-1.5 text-muted-foreground', className)}
      title={labels.map(({ name }) => name).join(', ')}
      variant="outline"
    >
      <span className="flex items-center -space-x-1">
        {labels.map((label) => (
          <LabelDot
            className="ring-2 ring-background"
            key={label.id}
            label={label}
          />
        ))}
      </span>
      {labels.length} labels
    </Badge>
  )
}

/**
 * The chip that opens the picker. Empty, it is the "add labels" affordance;
 * filled, it summarizes the selection the same way the read-only chips do.
 */
export function TaskLabelsPillTrigger({
  labels,
  className,
  ref,
  ...props
}: ComponentPropsWithRef<'span'> & {
  readonly labels: readonly TaskLabelOption[]
}): ReactElement {
  return (
    <span
      className={cn(
        'inline-flex h-6 max-w-48 items-center gap-1.5 rounded-full border border-border px-2 text-xs transition-colors hover:bg-muted',
        labels.length === 0 ? 'text-muted-foreground' : 'text-foreground',
        className
      )}
      ref={ref}
      {...props}
    >
      {labels.length === 0 ? (
        <>
          <Tag className="size-3.5" />
          Labels
        </>
      ) : (
        <>
          <span className="flex items-center -space-x-1">
            {labels.map((label) => (
              <LabelDot
                className="ring-2 ring-background"
                key={label.id}
                label={label}
              />
            ))}
          </span>
          <span className="truncate">
            {labels.length === 1
              ? labels[0]?.name
              : `${String(labels.length)} labels`}
          </span>
        </>
      )}
    </span>
  )
}
