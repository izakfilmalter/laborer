/**
 * A pull request body, rendered with the app's markdown renderer plus a
 * card for each upload embedded in it, which that renderer drops on the
 * floor. Ported from t3code's `PullRequestMarkdown.tsx`.
 *
 * The card links out instead of playing in place: a
 * `github.com/user-attachments/assets/…` link is a 302 to a signed S3 URL
 * that serves the file as uploaded — often `video/quicktime`, which no
 * Chromium decodes — so a player here can only be the box that never fills
 * in. Laborer adaptation: relative links in the body are resolved against
 * the pull request's own URL (`resolveMarkdownLinks`), and outbound links
 * leave the Electron shell through `GitHubLink`'s openExternal path.
 */
import { Markdown } from '@laborer/ui/components/markdown'
import { cn } from '@laborer/ui/lib/utils'
import { ExternalLink, Paperclip, Play } from 'lucide-react'
import { GitHubLink, resolveMarkdownLinks } from './external-links'
import { splitPullRequestBody } from './markdown-logic'

export function PullRequestMarkdown({
  text,
  baseHref,
  className,
}: {
  text: string
  /** The pull request's own URL, which relative links are written against. */
  baseHref?: string | null | undefined
  className?: string
}) {
  const segments = splitPullRequestBody(text)
  return (
    <div className={cn('space-y-3', className)}>
      {segments.map((segment) => {
        if (segment.kind === 'markdown') {
          return (
            <Markdown className="text-xs" key={segment.id}>
              {resolveMarkdownLinks(segment.text, baseHref)}
            </Markdown>
          )
        }
        const isVideo = segment.media === 'video'
        const Icon = isVideo ? Play : Paperclip
        return (
          <GitHubLink
            className="flex items-center gap-2 rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-sm hover:bg-muted/60"
            href={segment.url}
            key={segment.id}
          >
            <Icon
              aria-hidden
              className="size-3.5 shrink-0 text-muted-foreground"
            />
            <span className="min-w-0 flex-1 truncate">
              {isVideo ? 'Play video on GitHub' : 'Open attachment on GitHub'}
            </span>
            <ExternalLink
              aria-hidden
              className="size-3 shrink-0 text-muted-foreground"
            />
          </GitHubLink>
        )
      })}
    </div>
  )
}
