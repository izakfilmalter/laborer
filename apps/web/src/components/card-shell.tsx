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
  /**
   * Controls pinned to the right of the status row. Status reads on the left,
   * what you can do about it sits on the right of the same rail, so a card
   * never has to spend a whole row on a pair of buttons.
   */
  readonly badgeActions?: ReactNode | undefined
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
   * Marks the card the operator is currently in. It fills rather than
   * outlines: the edge is the attention channel — an agent that is blocked
   * or has a result waiting — and a bright edge on the card you are already
   * looking at is noise competing with the one cue worth interrupting for.
   * A lifted surface answers "you are here" without raising its voice, and
   * leaves an active card that also wants you legible as both at once.
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
const isNestedControl = (event: MouseEvent): boolean => {
  if (!(event.target instanceof Element)) {
    return false
  }
  const control = event.target.closest('a,button,[role="button"]')
  return control !== null && control !== event.currentTarget
}

function CardShell({
  actions,
  activateLabel,
  badgeActions,
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
        // the top of the active surface it would otherwise repaint.
        onActivate && !selected && 'transition-shadow hover:ring-foreground/25',
        // Fill, not outline: a lifted surface for "you are here", so the ring
        // stays free for a status that actually wants the operator. The edge
        // is only nudged up a step, which the light theme needs — its accent
        // and card sit a hair apart and the fill alone would say nothing.
        selected && 'bg-accent/20 ring-foreground/20',
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
      <CardHeader className="gap-1.5">
        {/* Title row: the name takes the slack, controls group hard right */}
        <div className="flex min-w-0 items-start gap-2">
          <div className="flex min-w-0 flex-1 items-start gap-2 overflow-hidden">
            {icon}
            <CardTitle className="min-w-0 flex-1">
              {onActivate ? (
                // A span rather than a button: card titles carry their own
                // controls — copy actions, links — and a button may not
                // contain a button. `role="button"` keeps the keyboard entry
                // point the card needs without breaking that nesting rule.
                // biome-ignore lint/a11y/useSemanticElements: a real button would nest the title's own buttons inside it, which is invalid HTML.
                <span
                  aria-label={activateLabel}
                  className="block w-full min-w-0 cursor-pointer text-left hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
                  onClick={(event) => {
                    if (isNestedControl(event)) {
                      return
                    }
                    onActivate()
                  }}
                  onKeyDown={(event) => {
                    if (event.target !== event.currentTarget) {
                      return
                    }
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      onActivate()
                    }
                  }}
                  role="button"
                  tabIndex={0}
                >
                  {title}
                </span>
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
        {/* Status rail: chips read left, their controls sit hard right on the
            same line. The minimum height is the height of a small button, so
            a column of cards keeps one rhythm whether or not a given card has
            controls — and chips stay centred against them when they do. */}
        {badges || badgeActions ? (
          <div className="flex items-start gap-2" data-slot="card-status-row">
            <div
              className={cn(
                'flex min-w-0 flex-wrap items-center gap-1.5 empty:hidden',
                // Only a row that carries controls needs to reserve their
                // height; a chip-only row stays as short as its chips.
                badgeActions && 'min-h-6'
              )}
            >
              {badges}
            </div>
            {/* `ml-auto` rather than `justify-between`, so the controls hold
                the right edge even when the card has no chips to sit
                opposite — which is the common case, since a healthy
                workspace reports nothing. */}
            {badgeActions ? (
              <div className="ml-auto flex shrink-0 items-center gap-1">
                {badgeActions}
              </div>
            ) : null}
          </div>
        ) : null}
      </CardHeader>
      {/* A body that renders nothing takes no room: without this the card's
          flex gap would still pay for a section that isn't there. */}
      {children ? (
        <CardContent className="empty:hidden">{children}</CardContent>
      ) : null}
    </Card>
  )
}

export { CardShell }
