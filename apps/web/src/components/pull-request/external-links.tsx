/**
 * Outbound links in the pull request conversation.
 *
 * Almost everything in this pane points back at github.com — the author, the
 * comment, the pull request, and whatever the comment body links to. Two
 * different problems follow from that: anchors this pane writes itself have
 * to leave the Electron shell rather than open a renderer window, and
 * anchors written by a commenter may be relative, in which case "github.com"
 * is an assumption the markup never states.
 *
 * Links inside a rendered body need no interception here. The shared
 * markdown renderer stamps `target="_blank"` on every anchor, and the shell's
 * `setWindowOpenHandler` already hands http(s) URLs to the system browser and
 * denies the window. What those links do need is an absolute destination,
 * which is what `resolveMarkdownLinks` gives them.
 */

import type * as React from 'react'
import { localApi } from '@/lib/local-api'

/** Leave the app the way the host platform expects, ignoring a failed hand-off. */
export const openExternally = (url: string) => {
  localApi.openExternal(url).catch(() => {
    // The link is still a real anchor; a failed hand-off is not worth a toast.
  })
}

/** An anchor that leaves the app the way the host platform expects. */
export function GitHubLink({
  children,
  className,
  href,
  title,
}: {
  readonly children: React.ReactNode
  readonly className?: string
  readonly href: string
  readonly title?: string
}) {
  return (
    <a
      className={className}
      href={href}
      onClick={(event) => {
        if (!localApi.isDesktop) {
          return
        }
        event.preventDefault()
        openExternally(href)
      }}
      rel="noopener noreferrer"
      target="_blank"
      title={title}
    >
      {children}
    </a>
  )
}

/**
 * Fenced blocks and code spans, held aside while destinations are rewritten
 * so a link written inside an example stays the text the commenter typed.
 */
const CODE_SEGMENT_RE = /(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`)/

/** The destination of an inline link or image: the `(…)` after a `[…]`. */
const INLINE_DESTINATION_RE = /(!?\[[^[\]]*\]\(\s*<?)([^\s()<>]*)/g

/** The destination of a reference definition: the `…` after a `[label]:`. */
const DEFINITION_DESTINATION_RE = /^([^\S\n]{0,3}\[[^\]]+\]:[^\S\n]*<?)(\S+)/gm

/** A destination that already names where it points — a scheme, or `//host`. */
const ABSOLUTE_DESTINATION_RE = /^(?:[a-z][a-z\d+.-]*:|\/\/)/i

const resolveDestination = (destination: string, base: string) => {
  if (destination.length === 0 || ABSOLUTE_DESTINATION_RE.test(destination)) {
    return destination
  }

  try {
    return new URL(destination, base).toString()
  } catch {
    // A base the URL parser rejects is not worth failing a comment over;
    // the destination stays as written, which is where it started.
    return destination
  }
}

/**
 * Rewrites relative destinations in a markdown body against the pull request
 * it was written on.
 *
 * `[the fix](/owner/repo/issues/5)` and `[#123](#123)` are ordinary in review
 * comments, and both mean somewhere on github.com — but the markup never says
 * so, so the browser resolves them against whatever origin is serving the
 * app, which is the daemon on localhost. GitHub Desktop avoids this by
 * handing its markdown renderer a `baseHref`; the shared renderer here takes
 * no such prop, so the destinations are resolved in the source before it ever
 * sees them.
 */
export function resolveMarkdownLinks(
  markdown: string,
  baseHref: string | null | undefined
): string {
  if (!baseHref) {
    return markdown
  }

  return markdown
    .split(CODE_SEGMENT_RE)
    .map((segment, index) =>
      // `split` with one capture group alternates prose and code, code odd.
      index % 2 === 1
        ? segment
        : segment
            .replace(
              INLINE_DESTINATION_RE,
              (_match: string, prefix: string, destination: string) =>
                `${prefix}${resolveDestination(destination, baseHref)}`
            )
            .replace(
              DEFINITION_DESTINATION_RE,
              (_match: string, prefix: string, destination: string) =>
                `${prefix}${resolveDestination(destination, baseHref)}`
            )
    )
    .join('')
}
