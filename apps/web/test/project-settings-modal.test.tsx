import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mutationMock,
  queryMock,
  buildConfigUpdatesMock,
  toastErrorMock,
  toastMessageMock,
  toastSuccessMock,
  updateConfigMock,
  useAtomSetMock,
  useAtomValueMock,
} = vi.hoisted(() => ({
  mutationMock: vi.fn(),
  queryMock: vi.fn(),
  buildConfigUpdatesMock: vi.fn(),
  toastErrorMock: vi.fn(),
  toastMessageMock: vi.fn(),
  toastSuccessMock: vi.fn(),
  updateConfigMock: vi.fn(),
  useAtomSetMock: vi.fn(),
  useAtomValueMock: vi.fn(),
}))

interface ConfigResult {
  readonly _tag: 'Success'
  readonly value: {
    readonly agent: {
      readonly value: 'opencode' | 'claude' | 'codex'
      readonly source: string
    }
    readonly worktreeDir: { readonly value: string; readonly source: string }
    readonly setupScripts: {
      readonly value: readonly string[]
      readonly source: string
    }
    readonly brrrConfig: {
      readonly value: string | null
      readonly source: string
    }
    readonly devServer: {
      readonly autoOpen: { readonly value: boolean; readonly source: string }
      readonly image: { readonly value: string | null; readonly source: string }
      readonly installCommand: {
        readonly value: string | null
        readonly source: string
      }
      readonly network: {
        readonly value: string | null
        readonly source: string
      }
      readonly setupScripts: {
        readonly value: readonly string[]
        readonly source: string
      }
      readonly startCommand: {
        readonly value: string | null
        readonly source: string
      }
    }
  }
}

let configResult: ConfigResult

vi.mock('@/atoms/laborer-client', () => ({
  ConfigReactivityKeys: ['config'],
  LaborerClient: {
    mutation: mutationMock,
    query: queryMock,
  },
}))

vi.mock('@effect-atom/atom-react/Hooks', () => ({
  useAtomSet: useAtomSetMock,
  useAtomValue: useAtomValueMock,
}))

vi.mock('@/components/project-settings-modal.helpers', () => ({
  buildConfigUpdates: buildConfigUpdatesMock,
  getSettingsLoadErrorMessage: () => 'Failed to load project settings.',
}))

vi.mock('@/lib/toast', () => ({
  toast: {
    error: toastErrorMock,
    message: toastMessageMock,
    success: toastSuccessMock,
  },
}))

vi.mock('@/components/agent-icons', () => ({
  AGENT_ICONS: {
    opencode: (props: Record<string, unknown>) => <span {...props}>OC</span>,
    claude: (props: Record<string, unknown>) => <span {...props}>CL</span>,
    codex: (props: Record<string, unknown>) => <span {...props}>CX</span>,
  },
}))

vi.mock('@/components/ui/select', () => ({
  Select: ({
    children,
  }: {
    children: React.ReactNode
    onValueChange: (value: string) => void
    value: string
  }) => <div>{children}</div>,
  SelectContent: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  SelectItem: ({ children }: { children: React.ReactNode; value: string }) => (
    <div>{children}</div>
  ),
  SelectTrigger: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  SelectValue: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

import { toast } from '@/lib/toast'
import { ProjectSettingsModal } from '../src/components/project-settings-modal'

describe('ProjectSettingsModal', () => {
  beforeEach(() => {
    vi.clearAllMocks()

    configResult = {
      _tag: 'Success',
      value: {
        agent: { value: 'opencode', source: 'default' },
        worktreeDir: { value: '/tmp/worktrees', source: 'laborer.json' },
        setupScripts: { value: ['bun install'], source: 'laborer.json' },
        brrrConfig: { value: '.brrr/config.toml', source: 'laborer.json' },
        devServer: {
          autoOpen: { value: false, source: 'default' },
          image: { value: null, source: 'default' },
          installCommand: { value: null, source: 'default' },
          network: { value: null, source: 'default' },
          setupScripts: { value: [], source: 'default' },
          startCommand: { value: null, source: 'default' },
        },
      },
    }

    queryMock.mockReturnValue({ _tag: 'MockQuery' })
    mutationMock.mockReturnValue({ _tag: 'MockMutation' })
    useAtomSetMock.mockReturnValue(updateConfigMock)
    useAtomValueMock.mockImplementation(() => configResult)
    updateConfigMock.mockResolvedValue(undefined)
    buildConfigUpdatesMock.mockReturnValue({
      worktreeDir: '~/dev/worktrees',
    })
  })

  it('opens the modal and renders resolved config values', async () => {
    render(<ProjectSettingsModal projectId="project-1" projectName="Laborer" />)

    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Open settings for Laborer' }))

    expect(screen.getByText('Project settings')).toBeTruthy()
    expect(screen.getByDisplayValue('/tmp/worktrees')).toBeTruthy()
    expect(screen.getByDisplayValue('bun install')).toBeTruthy()
    expect(screen.getByDisplayValue('.brrr/config.toml')).toBeTruthy()
    expect(queryMock).toHaveBeenCalledWith(
      'config.get',
      { projectId: 'project-1' },
      { reactivityKeys: ['config'] }
    )
  })

  it('saves updated fields and shows success toast', async () => {
    render(<ProjectSettingsModal projectId="project-1" projectName="Laborer" />)

    const user = userEvent.setup()
    await user.click(
      screen.getByRole('button', { name: 'Open settings for Laborer' })
    )
    fireEvent.submit(document.querySelector('form') as HTMLFormElement)

    await waitFor(() => {
      expect(updateConfigMock).toHaveBeenCalledWith({
        payload: {
          projectId: 'project-1',
          config: {
            worktreeDir: '~/dev/worktrees',
          },
        },
        reactivityKeys: ['config'],
      })
    })

    expect(toast.success).toHaveBeenCalledWith('Saved settings for Laborer')
  })

  it('shows an error toast when save fails', async () => {
    updateConfigMock.mockRejectedValue(new Error('save failed'))

    render(<ProjectSettingsModal projectId="project-1" projectName="Laborer" />)

    const user = userEvent.setup()
    await user.click(
      screen.getByRole('button', { name: 'Open settings for Laborer' })
    )
    fireEvent.submit(document.querySelector('form') as HTMLFormElement)

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('save failed')
    })
  })
})
