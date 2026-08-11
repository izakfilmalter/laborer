/**
 * The one card shape shared by the sidebar's workspace cards and the kanban
 * board's task cards.
 *
 * Both surfaces show the same kind of thing — a unit of work with a name, a
 * cluster of controls, a row of status chips, and an optional body — so they
 * render the same shell rather than two drifting layouts. The shell owns the
 * arrangement only; each caller keeps its own data source, its own actions,
 * and its own badges.
 *
 * Activation is optional. A card that can be activated gets a body click for
 * the mouse and a real button on its title for the keyboard, because a card
 * that only responds to a click on a div is unreachable without one.
 */

import type { ComponentProps, MouseEvent, ReactNode } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { cn } from '@/lib/utils'

interface CardShellProps
  extends Omit<ComponentProps<'div'>, 'onClick' | 'title'> {
  /** Control cluster pinned to the top right of the header. */
  readonly actions?: ReactNode | undefined
  /** Accessible name for the title's activation button. */
  readonly activateLabel?: string | undefined
  /** Chip row beneath the title: status, source, PR, worktree state. */
  readonly badges?: ReactNode | undefined
  /** Card body, rendered below the header when present. */
  readonly children?: ReactNode | undefined
  /** Leading icon beside the title. */
  readonly icon?: ReactNode | undefined
  /**
   * Runs when the card is activated. Omit it to leave the card inert — an
   * activation that would go nowhere should not advertise itself as clickable.
   */
  readonly onActivate?: (() => void) | undefined
  /**
   * Draws the active edge. The card's resting edge is a ring rather than a
   * border, so the accent has to be one too — a border colour on a card with
   * no border width paints nothing at all.
   */
  readonly selected?: boolean | undefined
  /** Secondary line under the title, usually a branch name. */
  readonly subtitle?: ReactNode | undefined
  readonly title: ReactNode
}

/**
 * Nested links and buttons own their own clicks. Without this, opening a PR
 * or a terminal from a chip would also activate the card underneath it.
 */
const isNestedControl = (event: MouseEvent): boolean =>
  event.target instanceof Element && event.target.closest('a,button') !== null

function CardShell({
  actions,
  activateLabel,
  badges,
  children,
  className,
  icon,
  onActivate,
  selected = false,
  subtitle,
  title,
  ...props
}: CardShellProps) {
  return (
    <Card
      className={cn(
        // Only a card that goes somewhere answers the pointer, and never over
        // the top of the active edge it would otherwise recolour.
        onActivate && !selected && 'transition-shadow hover:ring-foreground/25',
        selected && 'ring-2 ring-primary',
        className
      )}
      data-slot="card-shell"
      onClick={
        onActivate
          ? (event) => {
              if (isNestedControl(event)) {
                return
              }
              onActivate()
            }
          : undefined
      }
      size="sm"
      {...props}
    >
      <CardHeader className="gap-2">
        {/* Title row: the name takes the slack, controls group hard right */}
        <div className="flex min-w-0 items-start gap-2">
          <div className="flex min-w-0 flex-1 items-start gap-2 overflow-hidden">
            {icon}
            <CardTitle className="min-w-0 flex-1">
              {onActivate ? (
                <button
                  aria-label={activateLabel}
                  className="block w-full min-w-0 cursor-pointer text-left hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
                  onClick={onActivate}
                  type="button"
                >
                  {title}
                </button>
              ) : (
                title
              )}
            </CardTitle>
          </div>
          {actions ? (
            <div className="flex shrink-0 items-center gap-1">{actions}</div>
          ) : null}
        </div>
        {subtitle}
        {badges ? (
          <div className="flex flex-wrap items-center gap-1.5">{badges}</div>
        ) : null}
      </CardHeader>
      {children ? <CardContent>{children}</CardContent> : null}
    </Card>
  )
}

export { CardShell }
