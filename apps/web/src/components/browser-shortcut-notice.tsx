import { Info } from 'lucide-react'
import { localApi } from '@/lib/local-api'

/**
 * Host-conditional notice explaining that browsers claim some shortcuts before
 * the app sees them.
 *
 * Per-control tooltips (see `close-shortcut-hint.tsx`) only reach someone who
 * is already hovering the right button. This states the whole class of
 * breakage once, wherever shortcuts are surfaced as a list. Renders nothing
 * inside the Electron shell, where every binding is reachable.
 *
 * @see apps/web/src/components/close-shortcut-hint.tsx — per-control hints
 */
function BrowserShortcutNotice() {
  if (localApi.isDesktop) {
    return null
  }

  return (
    <div
      className="flex items-start gap-2 rounded-md border border-amber-500/20 bg-amber-500/5 px-3 py-2.5 text-muted-foreground text-xs leading-relaxed"
      data-testid="browser-shortcut-notice"
    >
      <Info
        aria-hidden="true"
        className="mt-0.5 size-3.5 shrink-0 text-amber-500"
      />
      <p>
        Your browser claims some shortcuts — including <b>⌘W</b>, <b>⌘⇧W</b>,
        and <b>⌘Q</b> — before laborer can see them, so they close the browser
        tab instead of a pane. Use the <b>⌃B</b> prefix sequences below, or the
        desktop app for full shortcut support.
      </p>
    </div>
  )
}

export { BrowserShortcutNotice }
