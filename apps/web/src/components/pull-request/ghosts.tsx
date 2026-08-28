/**
 * Loading states specific to the pull request surface, ported from
 * t3code's `PullRequestGhosts.tsx`: bars in the geometry of the content
 * they stand for, pulsing on one composited layer.
 *
 * Deliberately not the app's shimmer skeleton: one `animate-ghost-pulse`
 * on the container is a single opacity animation however many bars sit
 * under it, and the bars take their tone from `muted-foreground` at low
 * alpha, which reads on both themes.
 */
import { cn } from '@laborer/ui/lib/utils'

function GhostBar({ className }: { className?: string | undefined }) {
  return (
    <div
      aria-hidden
      className={cn('h-3 rounded bg-muted-foreground/15', className)}
    />
  )
}

/** Widths cycle rather than randomize, so the ghost renders the same on every pass. */
const TITLE_WIDTHS = [
  'w-3/5',
  'w-2/5',
  'w-1/2',
  'w-2/3',
  'w-2/5',
  'w-3/5',
  'w-1/2',
]
const META_WIDTHS = [
  'w-2/5',
  'w-1/3',
  'w-2/5',
  'w-1/4',
  'w-1/3',
  'w-2/5',
  'w-1/3',
]

/**
 * The detail panel's expanded shape. Keeping the chrome, summary facts,
 * and description boundaries in the ghost prevents the loaded pull
 * request from replacing one layout with another a moment later.
 */
export function PullRequestDetailGhost() {
  return (
    <output
      aria-label="Loading pull request"
      className="flex h-full min-h-0 animate-ghost-pulse flex-col overflow-hidden bg-background"
    >
      <div className="shrink-0 border-border/60 border-b">
        <div className="flex h-7 items-center justify-between gap-3 px-4">
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
            <GhostBar className="w-24" />
            <GhostBar className="w-9" />
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <GhostBar className="h-5 w-16 rounded-md" />
            <GhostBar className="size-5 rounded-md" />
          </div>
        </div>

        <div className="px-4 pt-1 pb-4">
          <GhostBar className="h-5 w-4/5 max-w-md" />
          <div className="mt-2 flex items-center gap-1.5">
            <GhostBar className="size-4 rounded-full" />
            <GhostBar className="w-24" />
          </div>
          <div className="mt-4 flex min-w-0 items-center gap-2">
            <GhostBar className="h-6 w-24 rounded-md" />
            <GhostBar className="size-3 rounded-full" />
            <GhostBar className="h-6 w-32 rounded-md" />
            <div className="ml-auto flex shrink-0 items-center gap-2">
              <GhostBar className="w-10" />
              <GhostBar className="w-20" />
            </div>
          </div>
        </div>

        <div className="flex min-h-10 items-center justify-between gap-3 border-border/60 border-t px-4 py-2">
          <div className="flex items-center gap-1 p-0.5">
            <GhostBar className="h-6 w-16 rounded-md" />
            <GhostBar className="h-6 w-16 rounded-md" />
            <GhostBar className="h-6 w-12 rounded-md" />
          </div>
          <GhostBar className="w-20" />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        <section className="px-4 py-3">
          <div className="grid min-h-8 grid-cols-[6rem_minmax(0,1fr)] items-center gap-2">
            <div className="flex items-center gap-1.5">
              <GhostBar className="size-3.5 rounded-full" />
              <GhostBar className="w-14" />
            </div>
            <div className="flex items-center gap-1">
              <GhostBar className="size-4 rounded-full" />
              <GhostBar className="size-4 rounded-full" />
              <GhostBar className="ml-1 size-5 rounded-md" />
            </div>
          </div>
          <div className="grid min-h-8 grid-cols-[6rem_minmax(0,1fr)] items-center gap-2">
            <div className="flex items-center gap-1.5">
              <GhostBar className="size-3.5 rounded-full" />
              <GhostBar className="w-10" />
            </div>
            <div className="flex items-center gap-1">
              <GhostBar className="h-5 w-24 rounded-full" />
              <GhostBar className="h-5 w-20 rounded-full" />
            </div>
          </div>
          <div className="grid min-h-8 grid-cols-[6rem_minmax(0,1fr)] items-center gap-2">
            <div className="flex items-center gap-1.5">
              <GhostBar className="size-3.5 rounded-full" />
              <GhostBar className="w-14" />
            </div>
            <GhostBar className="w-20" />
          </div>
        </section>

        <section className="border-border/60 border-t">
          <div className="flex min-h-11 items-center gap-1.5 px-4 py-3">
            <GhostBar className="h-4 w-24" />
            <GhostBar className="size-3.5 rounded-full" />
          </div>
          <div className="space-y-2 px-4 pb-4">
            <GhostBar className="w-full" />
            <GhostBar className="w-11/12" />
            <GhostBar className="w-4/5" />
            <GhostBar className="w-2/3" />
          </div>
        </section>
      </div>
    </output>
  )
}

/** People-shaped: an avatar and a name, in the reviewer picker's own row height. */
export function PullRequestPeopleGhost({ rows = 4 }: { rows?: number }) {
  return (
    <output
      aria-label="Loading people"
      className="block animate-ghost-pulse space-y-1 p-1"
    >
      {Array.from({ length: rows }, (_, index) => (
        <div
          className="flex h-7 items-center gap-2 rounded-md px-2"
          // biome-ignore lint/suspicious/noArrayIndexKey: identical placeholders with no identity beyond position.
          key={index}
        >
          <GhostBar className="size-4 rounded-full" />
          <GhostBar className={META_WIDTHS[index % META_WIDTHS.length]} />
        </div>
      ))}
    </output>
  )
}

/** The timeline's own shape: dots on the rail, a line and a date to each. */
export function PullRequestTimelineGhost({ rows = 6 }: { rows?: number }) {
  return (
    <output
      aria-label="Loading timeline"
      className="block animate-ghost-pulse px-4 py-5"
    >
      <div className="relative ml-2 border-border/70 border-l pl-5">
        {Array.from({ length: rows }, (_, index) => (
          <div
            className="relative pb-5"
            // biome-ignore lint/suspicious/noArrayIndexKey: identical placeholders with no identity beyond position.
            key={index}
          >
            <GhostBar className="absolute top-1 -left-[1.55rem] size-2 rounded-full" />
            <GhostBar
              className={cn('h-3.5', TITLE_WIDTHS[index % TITLE_WIDTHS.length])}
            />
            <GhostBar className="mt-1.5 w-16" />
          </div>
        ))}
      </div>
    </output>
  )
}

/** A compact placeholder for the conversation while the core detail is readable. */
export function PullRequestConversationGhost({ rows = 3 }: { rows?: number }) {
  return (
    <output
      aria-label="Loading pull request conversation"
      className="block animate-ghost-pulse space-y-4 py-2"
    >
      {Array.from({ length: rows }, (_, index) => (
        <div
          className="flex items-start gap-2"
          // biome-ignore lint/suspicious/noArrayIndexKey: identical placeholders with no identity beyond position.
          key={index}
        >
          <GhostBar className="size-5 shrink-0 rounded-full" />
          <div className="flex-1 space-y-1.5">
            <GhostBar className={META_WIDTHS[index % META_WIDTHS.length]} />
            <GhostBar className="w-full" />
            <GhostBar className="w-3/4" />
          </div>
        </div>
      ))}
    </output>
  )
}
