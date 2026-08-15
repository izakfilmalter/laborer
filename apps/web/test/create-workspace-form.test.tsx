import { JSDOM } from 'jsdom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

if (typeof document === 'undefined') {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost/',
  })
  const testGlobal = globalThis as typeof globalThis & {
    document: Document
    HTMLElement: typeof HTMLElement
    navigator: Navigator
    Node: typeof Node
    window: Window & typeof globalThis
  }

  testGlobal.window = dom.window as Window & typeof globalThis
  testGlobal.document = dom.window.document
  testGlobal.HTMLElement = dom.window.HTMLElement
  testGlobal.Node = dom.window.Node
  testGlobal.navigator = dom.window.navigator
  testGlobal.HTMLElement.prototype.attachEvent = () => undefined
  testGlobal.HTMLElement.prototype.detachEvent = () => undefined
}

const { act, cleanup, fireEvent, render, screen, waitFor } = await import(
  '@testing-library/react'
)
const { default: userEvent } = await import('@testing-library/user-event')

interface CreateWorkspaceFormTestMocks {
  readonly createWorkspaceFn: ReturnType<typeof vi.fn>
  readonly mutationMap: Map<unknown, ReturnType<typeof vi.fn>>
  readonly panelActionsMock: {
    readonly autoOpenAgentWhenWorkspaceReady: ReturnType<typeof vi.fn>
  }
  readonly planSlackWorkspaceFn: ReturnType<typeof vi.fn>
  readonly toastErrorFn: ReturnType<typeof vi.fn>
  readonly toastSuccessFn: ReturnType<typeof vi.fn>
}

const getCreateWorkspaceFormTestMocks = (): CreateWorkspaceFormTestMocks => {
  const testGlobal = globalThis as typeof globalThis & {
    __createWorkspaceFormTestMocks?: CreateWorkspaceFormTestMocks | undefined
  }

  testGlobal.__createWorkspaceFormTestMocks ??= {
    createWorkspaceFn: vi.fn(),
    planSlackWorkspaceFn: vi.fn(),
    mutationMap: new Map<unknown, ReturnType<typeof vi.fn>>(),
    panelActionsMock: { autoOpenAgentWhenWorkspaceReady: vi.fn() },
    toastErrorFn: vi.fn(),
    toastSuccessFn: vi.fn(),
  }

  return testGlobal.__createWorkspaceFormTestMocks
}

const { createWorkspaceFn, panelActionsMock, planSlackWorkspaceFn } =
  getCreateWorkspaceFormTestMocks()

vi.mock('@effect/atom-react/Hooks', () => ({
  useAtomSet: (atom: unknown) => {
    return getCreateWorkspaceFormTestMocks().mutationMap.get(atom) ?? vi.fn()
  },
}))

vi.mock('@/atoms/laborer-client', () => ({
  LaborerClient: {
    mutation: (name: string) => {
      const sentinel = Symbol.for(`mutation:${name}`)
      if (name === 'workspace.create') {
        const mocks = getCreateWorkspaceFormTestMocks()
        mocks.mutationMap.set(sentinel, mocks.createWorkspaceFn)
      }
      if (name === 'workspace.planFromSlack') {
        const mocks = getCreateWorkspaceFormTestMocks()
        mocks.mutationMap.set(sentinel, mocks.planSlackWorkspaceFn)
      }
      return sentinel
    },
  },
}))

vi.mock('@/lib/toast', () => ({
  toast: {
    error: getCreateWorkspaceFormTestMocks().toastErrorFn,
    success: getCreateWorkspaceFormTestMocks().toastSuccessFn,
  },
}))

vi.mock('@/panels/panel-context', () => ({
  usePanelActions: () => getCreateWorkspaceFormTestMocks().panelActionsMock,
}))

vi.mock('@laborer/ui/components/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="tooltip-wrapper">{children}</div>
  ),
  TooltipTrigger: ({ render }: { render: React.ReactElement }) => render,
  TooltipContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="tooltip-content">{children}</div>
  ),
}))

// Mock Dialog to render inline (no portal) so content is accessible in jsdom.
// The trigger is hidden so it doesn't collide with the submit button's accessible name.
vi.mock('@laborer/ui/components/dialog', () => ({
  Dialog: ({
    children,
    onOpenChange,
    open,
  }: {
    children: React.ReactNode
    onOpenChange: (open: boolean) => void
    open: boolean
  }) => (
    <div data-open={String(open)} data-testid="dialog">
      <button
        data-testid="dialog-open-control"
        onClick={() => onOpenChange(true)}
        style={{ display: 'none' }}
        type="button"
      />
      {children}
    </div>
  ),
  DialogContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="dialog-content">{children}</div>
  ),
  DialogDescription: ({ children }: { children: React.ReactNode }) => (
    <p>{children}</p>
  ),
  DialogFooter: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="dialog-footer">{children}</div>
  ),
  DialogHeader: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogTitle: ({ children }: { children: React.ReactNode }) => (
    <h2>{children}</h2>
  ),
  DialogTrigger: () => null,
}))

// Mock progress/spinner — not relevant for input mask tests
vi.mock('@laborer/ui/components/progress', () => ({
  Progress: () => null,
}))

vi.mock('@laborer/ui/components/spinner', () => ({
  Spinner: () => null,
}))

const { CreateWorkspaceForm } = await import(
  '../src/components/create-workspace-form'
)
const { ReadyPhaseWrapper } = await import('./helpers/lifecycle-test-utils')

const BRANCH_OR_SLACK_RE = /branch name or slack url/i
const CREATE_WORKSPACE_RE = /create workspace/i
const SLACK_HINT_RE = /read the conversation/i
const BRANCH_HINT_RE = /auto-generate a branch name/i

/** Return the combined branch/Slack input (dialog is rendered inline by the mock). */
function getBranchInput() {
  return screen.getByRole('textbox', { name: BRANCH_OR_SLACK_RE })
}

describe('CreateWorkspaceForm — branch name mask', () => {
  afterEach(() => {
    cleanup()
  })

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('autofocuses the combined input', () => {
    render(
      <ReadyPhaseWrapper>
        <CreateWorkspaceForm projectId="project-1" projectName="laborer" />
      </ReadyPhaseWrapper>
    )
    const input = getBranchInput()
    expect(document.activeElement).toBe(input)
  })

  it('renders a single input mentioning both branch names and Slack URLs', () => {
    render(
      <ReadyPhaseWrapper>
        <CreateWorkspaceForm projectId="project-1" projectName="my-app" />
      </ReadyPhaseWrapper>
    )
    const input = getBranchInput()
    expect(input).toBeTruthy()
    expect(screen.getAllByRole('textbox')).toHaveLength(1)
    expect(input.getAttribute('placeholder')).toBe(
      'my-app/my-feature or a Slack URL'
    )
    expect(screen.getByText(BRANCH_HINT_RE)).toBeTruthy()
  })

  it('swaps the hint to Slack guidance once a URL is entered', async () => {
    const user = userEvent.setup()
    render(
      <ReadyPhaseWrapper>
        <CreateWorkspaceForm projectId="project-1" projectName="laborer" />
      </ReadyPhaseWrapper>
    )

    await user.type(
      getBranchInput(),
      'https://example.slack.com/archives/C12345678/p1750000000000000'
    )

    await waitFor(() => {
      expect(screen.getByText(SLACK_HINT_RE)).toBeTruthy()
    })
    expect(screen.queryByText(BRANCH_HINT_RE)).toBeNull()
  })

  it('converts spaces to hyphens', async () => {
    const user = userEvent.setup()
    render(
      <ReadyPhaseWrapper>
        <CreateWorkspaceForm projectId="project-1" projectName="laborer" />
      </ReadyPhaseWrapper>
    )
    const input = getBranchInput()

    await user.type(input, 'my feature branch')

    await waitFor(() => {
      expect((input as HTMLInputElement).value).toBe('my-feature-branch')
    })
  })

  it('converts uppercase to lowercase', async () => {
    const user = userEvent.setup()
    render(
      <ReadyPhaseWrapper>
        <CreateWorkspaceForm projectId="project-1" projectName="laborer" />
      </ReadyPhaseWrapper>
    )
    const input = getBranchInput()

    await user.type(input, 'My-Feature')

    await waitFor(() => {
      expect((input as HTMLInputElement).value).toBe('my-feature')
    })
  })

  it('allows forward slashes for namespaced branches', async () => {
    const user = userEvent.setup()
    render(
      <ReadyPhaseWrapper>
        <CreateWorkspaceForm projectId="project-1" projectName="laborer" />
      </ReadyPhaseWrapper>
    )
    const input = getBranchInput()

    await user.type(input, 'laborer/my-feature')

    await waitFor(() => {
      expect((input as HTMLInputElement).value).toBe('laborer/my-feature')
    })
  })

  it('allows hyphens and underscores', async () => {
    const user = userEvent.setup()
    render(
      <ReadyPhaseWrapper>
        <CreateWorkspaceForm projectId="project-1" projectName="laborer" />
      </ReadyPhaseWrapper>
    )
    const input = getBranchInput()

    await user.type(input, 'my-feature_branch')

    await waitFor(() => {
      expect((input as HTMLInputElement).value).toBe('my-feature_branch')
    })
  })

  it('rejects special characters not allowed in branch names', async () => {
    const user = userEvent.setup()
    render(
      <ReadyPhaseWrapper>
        <CreateWorkspaceForm projectId="project-1" projectName="laborer" />
      </ReadyPhaseWrapper>
    )
    const input = getBranchInput()

    await user.type(input, 'feat!@#$%ok')

    await waitFor(() => {
      expect((input as HTMLInputElement).value).toBe('featok')
    })
  })

  it('submits with only projectId when branch name is empty', async () => {
    const user = userEvent.setup()
    createWorkspaceFn.mockResolvedValue({
      id: 'ws-new',
      projectId: 'project-1',
      branchName: 'auto-generated-branch',
      worktreePath: '/path/to/worktree',
      status: 'running',
    })

    render(
      <ReadyPhaseWrapper>
        <CreateWorkspaceForm projectId="project-1" projectName="laborer" />
      </ReadyPhaseWrapper>
    )

    const submitButton = screen.getByRole('button', {
      name: CREATE_WORKSPACE_RE,
    })
    await user.click(submitButton)

    await waitFor(() => {
      expect(createWorkspaceFn).toHaveBeenCalledWith({
        payload: {
          projectId: 'project-1',
        },
      })
      expect(
        panelActionsMock.autoOpenAgentWhenWorkspaceReady
      ).toHaveBeenCalledWith('ws-new')
    })
  })

  it('submits the masked branch name', async () => {
    const user = userEvent.setup()
    createWorkspaceFn.mockResolvedValue({
      id: 'ws-new',
      projectId: 'project-1',
      branchName: 'my-feature-branch',
      worktreePath: '/path/to/worktree',
      status: 'running',
    })

    render(
      <ReadyPhaseWrapper>
        <CreateWorkspaceForm projectId="project-1" projectName="laborer" />
      </ReadyPhaseWrapper>
    )
    const input = getBranchInput()

    await user.type(input, 'My Feature Branch')

    await waitFor(() => {
      expect((input as HTMLInputElement).value).toBe('my-feature-branch')
    })

    const submitButton = screen.getByRole('button', {
      name: CREATE_WORKSPACE_RE,
    })
    await user.click(submitButton)

    await waitFor(() => {
      expect(createWorkspaceFn).toHaveBeenCalledWith({
        payload: {
          projectId: 'project-1',
          branchName: 'my-feature-branch',
        },
      })
    })
  })

  it('keeps Slack URLs verbatim instead of masking them as a branch name', async () => {
    const user = userEvent.setup()
    const slackUrl =
      'https://Example.slack.com/archives/C12345678/p1750000000000000?thread_ts=1.2'

    render(
      <ReadyPhaseWrapper>
        <CreateWorkspaceForm projectId="project-1" projectName="laborer" />
      </ReadyPhaseWrapper>
    )
    const input = getBranchInput()

    await user.type(input, slackUrl)

    await waitFor(() => {
      expect((input as HTMLInputElement).value).toBe(slackUrl)
    })
  })

  it('treats a scheme-less Slack URL as a Slack URL', async () => {
    const user = userEvent.setup()
    planSlackWorkspaceFn.mockResolvedValue({
      branchName: 'slack/fix-auth-timeout',
      initialPrompt: 'Fix it.',
      workType: 'bug',
    })
    createWorkspaceFn.mockResolvedValue({
      id: 'ws-slack',
      projectId: 'project-1',
      branchName: 'slack/fix-auth-timeout',
      worktreePath: '/path/to/worktree',
      status: 'creating',
    })

    render(
      <ReadyPhaseWrapper>
        <CreateWorkspaceForm projectId="project-1" projectName="laborer" />
      </ReadyPhaseWrapper>
    )

    await user.type(
      getBranchInput(),
      'example.slack.com/archives/C12345678/p1750000000000000'
    )
    await user.click(screen.getByRole('button', { name: CREATE_WORKSPACE_RE }))

    await waitFor(() => {
      expect(planSlackWorkspaceFn).toHaveBeenCalledWith({
        payload: {
          slackUrl:
            'https://example.slack.com/archives/C12345678/p1750000000000000',
        },
      })
    })
  })

  it('plans from Slack and opens OpenCode with the generated prompt', async () => {
    const user = userEvent.setup()
    const slackUrl =
      'https://example.slack.com/archives/C12345678/p1750000000000000'
    const initialPrompt = 'Fix the timeout described by the Slack thread.'
    planSlackWorkspaceFn.mockResolvedValue({
      branchName: 'slack/fix-auth-timeout',
      initialPrompt,
      workType: 'bug',
    })
    createWorkspaceFn.mockResolvedValue({
      id: 'ws-slack',
      projectId: 'project-1',
      branchName: 'slack/fix-auth-timeout',
      worktreePath: '/path/to/worktree',
      status: 'creating',
    })

    render(
      <ReadyPhaseWrapper>
        <CreateWorkspaceForm projectId="project-1" projectName="laborer" />
      </ReadyPhaseWrapper>
    )

    await user.type(getBranchInput(), slackUrl)
    await user.click(screen.getByRole('button', { name: CREATE_WORKSPACE_RE }))

    await waitFor(() => {
      expect(planSlackWorkspaceFn).toHaveBeenCalledWith({
        payload: { slackUrl },
      })
      expect(createWorkspaceFn).toHaveBeenCalledWith({
        payload: {
          projectId: 'project-1',
          branchName: 'slack/fix-auth-timeout',
        },
      })
      expect(
        panelActionsMock.autoOpenAgentWhenWorkspaceReady
      ).toHaveBeenCalledWith('ws-slack', { initialPrompt })
    })
  })

  it('moves Slack planning into a pending sidebar item and reports completion', async () => {
    const user = userEvent.setup()
    const slackUrl =
      'https://example.slack.com/archives/C12345678/p1750000000000000'
    const initialPrompt = 'Fix the timeout described by the Slack thread.'
    let resolvePlan:
      | ((value: {
          branchName: string
          initialPrompt: string
          workType: string
        }) => void)
      | undefined
    let resolveCreate:
      | ((value: {
          id: string
          projectId: string
          branchName: string
          worktreePath: string
          status: string
        }) => void)
      | undefined
    const pendingChanges = vi.fn()

    planSlackWorkspaceFn.mockReturnValue(
      new Promise((resolve) => {
        resolvePlan = resolve
      })
    )
    createWorkspaceFn.mockReturnValue(
      new Promise((resolve) => {
        resolveCreate = resolve
      })
    )

    render(
      <ReadyPhaseWrapper>
        <CreateWorkspaceForm
          onPendingCreationChange={pendingChanges}
          projectId="project-1"
          projectName="laborer"
        />
      </ReadyPhaseWrapper>
    )

    fireEvent.click(screen.getByTestId('dialog-open-control'))
    expect(screen.getByTestId('dialog').getAttribute('data-open')).toBe('true')

    await user.type(getBranchInput(), slackUrl)
    await user.click(screen.getByRole('button', { name: CREATE_WORKSPACE_RE }))

    await waitFor(() => {
      expect(screen.getByTestId('dialog').getAttribute('data-open')).toBe(
        'false'
      )
      expect(pendingChanges).toHaveBeenCalledWith({
        creation: {
          branchName: null,
          id: expect.any(String),
          phase: 'analyzing',
        },
        id: expect.any(String),
      })
    })
    expect(createWorkspaceFn).not.toHaveBeenCalled()

    act(() => {
      resolvePlan?.({
        branchName: 'slack/fix-auth-timeout',
        initialPrompt,
        workType: 'bug',
      })
    })

    await waitFor(() => {
      expect(pendingChanges).toHaveBeenCalledWith({
        creation: {
          branchName: 'slack/fix-auth-timeout',
          id: expect.any(String),
          phase: 'creating',
        },
        id: expect.any(String),
      })
      expect(createWorkspaceFn).toHaveBeenCalled()
    })

    act(() => {
      resolveCreate?.({
        id: 'ws-slack',
        projectId: 'project-1',
        branchName: 'slack/fix-auth-timeout',
        worktreePath: '/path/to/worktree',
        status: 'creating',
      })
    })

    await waitFor(() => {
      expect(pendingChanges).toHaveBeenLastCalledWith({
        creation: null,
        id: expect.any(String),
      })
      expect(
        getCreateWorkspaceFormTestMocks().toastSuccessFn
      ).toHaveBeenCalledWith(
        'Workspace "slack/fix-auth-timeout" is being set up with its Slack prompt'
      )
    })
  })

  it('removes the pending item and reports an error when Slack planning fails', async () => {
    const user = userEvent.setup()
    const pendingChanges = vi.fn()
    planSlackWorkspaceFn.mockRejectedValue(new Error('Could not read Slack'))

    render(
      <ReadyPhaseWrapper>
        <CreateWorkspaceForm
          onPendingCreationChange={pendingChanges}
          projectId="project-1"
          projectName="laborer"
        />
      </ReadyPhaseWrapper>
    )

    await user.type(
      getBranchInput(),
      'https://example.slack.com/archives/C12345678/p1750000000000000'
    )
    await user.click(screen.getByRole('button', { name: CREATE_WORKSPACE_RE }))

    await waitFor(() => {
      expect(pendingChanges).toHaveBeenLastCalledWith({
        creation: null,
        id: expect.any(String),
      })
      expect(
        getCreateWorkspaceFormTestMocks().toastErrorFn
      ).toHaveBeenCalledWith('Could not read Slack')
    })
    expect(createWorkspaceFn).not.toHaveBeenCalled()
  })

  it('preserves forward slashes in branch names on submit', async () => {
    const user = userEvent.setup()
    createWorkspaceFn.mockResolvedValue({
      id: 'ws-new',
      projectId: 'project-1',
      branchName: 'if/batch-column-variant-prd',
      worktreePath: '/path/to/worktree',
      status: 'running',
    })

    render(
      <ReadyPhaseWrapper>
        <CreateWorkspaceForm projectId="project-1" projectName="laborer" />
      </ReadyPhaseWrapper>
    )
    const input = getBranchInput()

    await user.type(input, 'if/batch-column-variant-prd')

    await waitFor(() => {
      expect((input as HTMLInputElement).value).toBe(
        'if/batch-column-variant-prd'
      )
    })

    const submitButton = screen.getByRole('button', {
      name: CREATE_WORKSPACE_RE,
    })
    await user.click(submitButton)

    await waitFor(() => {
      expect(createWorkspaceFn).toHaveBeenCalledWith({
        payload: {
          projectId: 'project-1',
          branchName: 'if/batch-column-variant-prd',
        },
      })
    })
  })
})
