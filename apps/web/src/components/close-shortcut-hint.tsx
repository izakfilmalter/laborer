import { Kbd, KbdGroup } from '@laborer/ui/components/kbd'
import { localApi } from '@/lib/local-api'

/**
 * Keyboard hint for the progressive close chain (pane → panel tab → workspace
 * → window tab → app).
 *
 * Browsers reserve ⌘W / Ctrl+W for closing their own tab and never deliver the
 * event to the page, so `Meta+W` only reaches the panel system inside the
 * Electron shell, where the app menu routes it through `close-pane`. In a
 * browser tab the tmux-style prefix sequence (Ctrl+B then X) is the shortcut
 * that actually runs the same chain, so advertise that instead of a shortcut
 * the host will swallow.
 *
 * @see apps/web/src/panels/panel-hotkeys.tsx — both bindings are registered there
 */
function CloseShortcutHint() {
  if (localApi.isDesktop) {
    return (
      <KbdGroup>
        <Kbd>⌘</Kbd>
        <Kbd>W</Kbd>
      </KbdGroup>
    )
  }

  return (
    <KbdGroup>
      <Kbd>⌃</Kbd>
      <Kbd>B</Kbd>
      <span className="text-xs opacity-70">then</span>
      <Kbd>X</Kbd>
    </KbdGroup>
  )
}

/**
 * Keyboard hint for closing the active window tab.
 *
 * Cmd+Shift+W is reserved by browsers (it closes the browser window), so the
 * prefix sequence is advertised outside the Electron shell.
 */
function CloseWindowTabShortcutHint() {
  if (localApi.isDesktop) {
    return (
      <KbdGroup>
        <Kbd>⌘</Kbd>
        <Kbd>⇧</Kbd>
        <Kbd>W</Kbd>
      </KbdGroup>
    )
  }

  return (
    <KbdGroup>
      <Kbd>⌃</Kbd>
      <Kbd>B</Kbd>
      <span className="text-xs opacity-70">then</span>
      <Kbd>⇧</Kbd>
      <Kbd>X</Kbd>
    </KbdGroup>
  )
}

export { CloseShortcutHint, CloseWindowTabShortcutHint }
