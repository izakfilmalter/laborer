import { Keyboard } from 'lucide-react'
import { BrowserShortcutNotice } from '@/components/browser-shortcut-notice'
import {
  CloseShortcutHint,
  CloseWindowTabShortcutHint,
} from '@/components/close-shortcut-hint'
import { Kbd, KbdGroup } from '@/components/ui/kbd'

/**
 * Static keyboard-shortcut reference shown in app settings.
 *
 * This is the one place the full shortcut vocabulary is surfaced as a list, so
 * it carries {@link BrowserShortcutNotice} — the single explanation of why some
 * bindings behave differently outside the Electron shell. The close rows reuse
 * the host-aware hints so the list never advertises a shortcut the host will
 * swallow.
 *
 * @see apps/web/src/panels/panel-hotkeys.tsx — where these are registered
 */

interface ShortcutRow {
  readonly hint: React.ReactNode
  readonly label: string
}

function keys(...parts: readonly string[]) {
  return (
    <KbdGroup>
      {parts.map((part) => (
        <Kbd key={part}>{part}</Kbd>
      ))}
    </KbdGroup>
  )
}

function sequence(prefix: readonly string[], then: readonly string[]) {
  return (
    <KbdGroup>
      {prefix.map((part) => (
        <Kbd key={part}>{part}</Kbd>
      ))}
      <span className="text-xs opacity-70">then</span>
      {then.map((part) => (
        <Kbd key={part}>{part}</Kbd>
      ))}
    </KbdGroup>
  )
}

const SHORTCUT_GROUPS: readonly {
  readonly rows: readonly ShortcutRow[]
  readonly title: string
}[] = [
  {
    title: 'Closing',
    rows: [
      {
        label: 'Close pane (escalates to tab, workspace, window)',
        hint: <CloseShortcutHint />,
      },
      { label: 'Close window tab', hint: <CloseWindowTabShortcutHint /> },
    ],
  },
  {
    title: 'Panes',
    rows: [
      { label: 'Split horizontally', hint: sequence(['⌃', 'B'], ['H']) },
      { label: 'Split vertically', hint: sequence(['⌃', 'B'], ['V']) },
      {
        label: 'Focus next / previous pane',
        hint: sequence(['⌃', 'B'], ['O / P']),
      },
      {
        label: 'Focus pane by direction',
        hint: sequence(['⌃', 'B'], ['←↑↓→']),
      },
      { label: 'Zoom active pane', hint: sequence(['⌃', 'B'], ['Z']) },
      {
        label: 'New agent / diff / dev server pane',
        hint: sequence(['⌃', 'B'], ['A / D / S']),
      },
      { label: 'Toggle file tree', hint: sequence(['⌃', 'B'], ['T']) },
    ],
  },
  {
    title: 'Tabs',
    rows: [
      { label: 'New panel tab', hint: keys('⌃', 'T') },
      { label: 'Switch panel tab', hint: keys('⌃', '1–9') },
      { label: 'New window tab', hint: keys('⌘', 'T') },
      { label: 'Switch window tab', hint: keys('⌘', '1–9') },
    ],
  },
]

function KeyboardShortcutsSection() {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Keyboard aria-hidden="true" className="h-5 w-5" />
        <h3 className="font-medium text-sm">Keyboard Shortcuts</h3>
      </div>

      <BrowserShortcutNotice />

      <div className="space-y-4">
        {SHORTCUT_GROUPS.map((group) => (
          <div className="space-y-1.5" key={group.title}>
            <p className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
              {group.title}
            </p>
            <ul className="space-y-1">
              {group.rows.map((row) => (
                <li
                  className="flex items-center justify-between gap-4 text-sm"
                  key={row.label}
                >
                  <span className="min-w-0 text-muted-foreground">
                    {row.label}
                  </span>
                  {row.hint}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  )
}

export { KeyboardShortcutsSection }
