import { describe, expect, it, vi } from 'vitest'
import {
  openProvisionedAgent,
  resolvePendingAgentOpen,
} from '@/components/kanban/provisioned-agent'

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

describe('deferred Slack provisioning resolution', () => {
  const pendingTask = {
    description: null,
    executionMirror: 'queued' as const,
    status: 'in_progress' as const,
    worktreePath: null,
  }
  const provisionedTask = {
    ...pendingTask,
    description: 'Fix the auth flow',
    executionMirror: null,
    worktreePath: '/worktrees/fix-auth',
  }
  const workspace = {
    id: 'workspace-1',
    status: 'creating',
    worktreePath: '/worktrees/fix-auth',
  }

  it('waits while the card has not reached the board projection yet', () => {
    expect(resolvePendingAgentOpen(undefined, [workspace])).toEqual({
      _tag: 'wait',
    })
  })

  it('waits while the analysis has not produced a workspace yet', () => {
    expect(resolvePendingAgentOpen(pendingTask, [])).toEqual({ _tag: 'wait' })
  })

  it('waits while the workspace row has not synced yet', () => {
    expect(resolvePendingAgentOpen(provisionedTask, [])).toEqual({
      _tag: 'wait',
    })
  })

  it('opens the agent with the planned prompt once the workspace lands', () => {
    expect(resolvePendingAgentOpen(provisionedTask, [workspace])).toEqual({
      _tag: 'open',
      description: 'Fix the auth flow',
      workspaceId: 'workspace-1',
    })
  })

  it('drops a card whose analysis failed', () => {
    expect(
      resolvePendingAgentOpen({ ...pendingTask, executionMirror: 'failed' }, [
        workspace,
      ])
    ).toEqual({ _tag: 'drop' })
  })

  it('drops a card that left In Progress', () => {
    expect(
      resolvePendingAgentOpen({ ...provisionedTask, status: 'todo' }, [
        workspace,
      ])
    ).toEqual({ _tag: 'drop' })
  })

  it('does not adopt a destroyed workspace at the same path', () => {
    expect(
      resolvePendingAgentOpen(provisionedTask, [
        { ...workspace, status: 'destroyed' },
      ])
    ).toEqual({ _tag: 'wait' })
  })
})
