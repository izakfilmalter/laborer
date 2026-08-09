import { describe, expect, it } from 'vitest'
import { WindowWorkspacePresenceRegistry } from '../src/window-workspace-presence.js'

const windowFact = () => ({ isDestroyed: () => false })

describe('WindowWorkspacePresenceRegistry', () => {
  it('answers focused-window, visibility, and focused-workspace queries', () => {
    const registry = new WindowWorkspacePresenceRegistry()
    const focusedWindow = windowFact()
    const backgroundWindow = windowFact()

    registry.update(focusedWindow, {
      contexts: [
        { branchName: 'feature/focus', workspaceId: 'focused-workspace' },
      ],
      focused: true,
      workspaceIds: ['focused-workspace'],
    })
    registry.update(backgroundWindow, {
      focused: false,
      workspaceIds: ['background-workspace'],
    })

    expect(registry.hasFocusedWindow()).toBe(true)
    expect(registry.isWorkspaceVisible('background-workspace')).toBe(true)
    expect(registry.isWorkspaceFocused('background-workspace')).toBe(false)
    expect(registry.isWorkspaceFocused('focused-workspace')).toBe(true)
    expect(registry.focusedWorkspaceIds()).toEqual(['focused-workspace'])
    expect(registry.branchNameForWorkspace('focused-workspace')).toBe(
      'feature/focus'
    )
  })

  it('drops destroyed windows from every query', () => {
    let destroyed = false
    const window = { isDestroyed: () => destroyed }
    const registry = new WindowWorkspacePresenceRegistry<typeof window>()
    registry.update(window, { focused: true, workspaceIds: ['workspace'] })

    destroyed = true
    expect(registry.hasFocusedWindow()).toBe(false)
    expect(registry.findWindowForWorkspace('workspace')).toBeNull()
  })

  it('routes an absent workspace to a fallback window that can open it', () => {
    const registry = new WindowWorkspacePresenceRegistry()
    const fallback = windowFact()
    let routedWindow: typeof fallback | null = null

    expect(
      registry.routeToOrOpenWorkspace(
        'not-visible',
        () => fallback,
        (window) => {
          routedWindow = window
        }
      )
    ).toBe(true)
    expect(routedWindow).toBe(fallback)
  })
})
