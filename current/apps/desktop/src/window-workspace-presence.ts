/** Minimal BrowserWindow surface needed by the presence registry. */
interface PresenceWindow {
  isDestroyed(): boolean
}

interface WindowPresence {
  readonly focused: boolean
  readonly workspaceIds: ReadonlySet<string>
}

/**
 * Main-process source of truth for workspace visibility and window focus.
 * Renderers report facts; consumers decide what those facts mean.
 */
class WindowWorkspacePresenceRegistry<TWindow extends PresenceWindow> {
  readonly #windows = new Map<TWindow, WindowPresence>()

  update(
    window: TWindow,
    facts: {
      readonly focused: boolean
      readonly workspaceIds: readonly string[]
    }
  ): void {
    if (window.isDestroyed()) {
      this.#windows.delete(window)
      return
    }
    this.#windows.set(window, {
      focused: facts.focused,
      workspaceIds: new Set(facts.workspaceIds),
    })
  }

  remove(window: TWindow): void {
    this.#windows.delete(window)
  }

  findWindowForWorkspace(workspaceId: string): TWindow | null {
    for (const [window, presence] of this.#liveEntries()) {
      if (presence.workspaceIds.has(workspaceId)) {
        return window
      }
    }
    return null
  }

  hasFocusedWindow(): boolean {
    return this.#liveEntries().some(([, presence]) => presence.focused)
  }

  isWorkspaceVisible(workspaceId: string): boolean {
    return this.#liveEntries().some(([, presence]) =>
      presence.workspaceIds.has(workspaceId)
    )
  }

  isWorkspaceFocused(workspaceId: string): boolean {
    return this.#liveEntries().some(
      ([, presence]) =>
        presence.focused && presence.workspaceIds.has(workspaceId)
    )
  }

  focusedWorkspaceIds(): readonly string[] {
    const ids = new Set<string>()
    for (const [, presence] of this.#liveEntries()) {
      if (presence.focused) {
        for (const workspaceId of presence.workspaceIds) {
          ids.add(workspaceId)
        }
      }
    }
    return [...ids]
  }

  #liveEntries(): [TWindow, WindowPresence][] {
    const entries: [TWindow, WindowPresence][] = []
    for (const [window, presence] of this.#windows) {
      if (window.isDestroyed()) {
        this.#windows.delete(window)
      } else {
        entries.push([window, presence])
      }
    }
    return entries
  }
}

export { WindowWorkspacePresenceRegistry }
export type { PresenceWindow }
