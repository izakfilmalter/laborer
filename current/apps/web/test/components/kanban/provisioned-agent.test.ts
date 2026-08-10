import { describe, expect, it, vi } from 'vitest'
import { openProvisionedAgent } from '@/components/kanban/provisioned-agent'

describe('provisioned task agent launch', () => {
  it('injects a stored description through the existing launch seam', () => {
    const openAgent = vi.fn()

    openProvisionedAgent(
      { description: 'Implement the task', workspaceId: 'workspace-1' },
      openAgent
    )

    expect(openAgent).toHaveBeenCalledWith('workspace-1', {
      initialPrompt: 'Implement the task',
    })
  })

  it('launches a descriptionless manual task without an initial prompt', () => {
    const openAgent = vi.fn()

    openProvisionedAgent(
      { description: null, workspaceId: 'workspace-1' },
      openAgent
    )

    expect(openAgent).toHaveBeenCalledWith('workspace-1')
  })

  it('does not launch for a pure status move', () => {
    const openAgent = vi.fn()

    openProvisionedAgent(
      { description: 'Do not relaunch', workspaceId: null },
      openAgent
    )

    expect(openAgent).not.toHaveBeenCalled()
  })
})
