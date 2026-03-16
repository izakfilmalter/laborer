import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { updateStatusFn, mutationMap, queryDbMock, useLaborerStoreMock } =
  vi.hoisted(() => ({
    updateStatusFn: vi.fn(),
    mutationMap: new Map<unknown, ReturnType<typeof vi.fn>>(),
    queryDbMock: vi.fn((_table, options: { label: string }) => options),
    useLaborerStoreMock: vi.fn(),
  }))

vi.mock('@effect-atom/atom-react/Hooks', () => ({
  useAtomSet: (atom: unknown) => {
    return mutationMap.get(atom) ?? vi.fn()
  },
}))

vi.mock('@/atoms/laborer-client', () => ({
  LaborerClient: {
    mutation: (name: string) => {
      const sentinel = Symbol.for(`mutation:${name}`)
      if (name === 'task.updateStatus') {
        mutationMap.set(sentinel, updateStatusFn)
      }
      return sentinel
    },
  },
}))

vi.mock('@livestore/livestore', () => ({
  queryDb: queryDbMock,
}))

vi.mock('@/livestore/store', () => ({
  useLaborerStore: useLaborerStoreMock,
}))

vi.mock('@laborer/shared/schema', () => ({
  tasks: { name: 'tasks' },
}))

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}))

import { PlanIssuesList } from '../src/components/plan-issues-list'

describe('PlanIssuesList', () => {
  afterEach(() => {
    cleanup()
  })

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders issues for the given prdId only', () => {
    useLaborerStoreMock.mockReturnValue({
      useQuery: () => [
        {
          id: 'task-1',
          projectId: 'project-1',
          source: 'prd',
          prdId: 'prd-1',
          title: 'Fix login flow',
          status: 'pending',
          externalId: '1',
        },
        {
          id: 'task-2',
          projectId: 'project-1',
          source: 'prd',
          prdId: 'prd-1',
          title: 'Add auth middleware',
          status: 'completed',
          externalId: '2',
        },
        {
          id: 'task-3',
          projectId: 'project-1',
          source: 'prd',
          prdId: 'prd-2',
          title: 'Different PRD task',
          status: 'pending',
          externalId: '1',
        },
        {
          id: 'task-4',
          projectId: 'project-1',
          source: 'github',
          prdId: null,
          title: 'GitHub task',
          status: 'pending',
          externalId: 'GH-1',
        },
      ],
    })

    render(<PlanIssuesList prdId="prd-1" />)

    expect(screen.getByText('Fix login flow')).toBeTruthy()
    expect(screen.getByText('Add auth middleware')).toBeTruthy()
    expect(screen.queryByText('Different PRD task')).toBeNull()
    expect(screen.queryByText('GitHub task')).toBeNull()
  })

  it('shows empty state when no issues exist for the prdId', () => {
    useLaborerStoreMock.mockReturnValue({
      useQuery: () => [],
    })

    render(<PlanIssuesList prdId="prd-1" />)

    expect(screen.getByText('No issues')).toBeTruthy()
    expect(
      screen.getByText(
        'Create issues for this plan through the MCP tools or AI agent.'
      )
    ).toBeTruthy()
  })

  it('displays status icons consistent with TaskList styling', () => {
    useLaborerStoreMock.mockReturnValue({
      useQuery: () => [
        {
          id: 'task-1',
          projectId: 'project-1',
          source: 'prd',
          prdId: 'prd-1',
          title: 'Pending issue',
          status: 'pending',
          externalId: null,
        },
        {
          id: 'task-2',
          projectId: 'project-1',
          source: 'prd',
          prdId: 'prd-1',
          title: 'In progress issue',
          status: 'in_progress',
          externalId: null,
        },
        {
          id: 'task-3',
          projectId: 'project-1',
          source: 'prd',
          prdId: 'prd-1',
          title: 'Completed issue',
          status: 'completed',
          externalId: null,
        },
        {
          id: 'task-4',
          projectId: 'project-1',
          source: 'prd',
          prdId: 'prd-1',
          title: 'Cancelled issue',
          status: 'cancelled',
          externalId: null,
        },
      ],
    })

    render(<PlanIssuesList prdId="prd-1" />)

    expect(screen.getByText('Pending issue')).toBeTruthy()
    expect(screen.getByText('In progress issue')).toBeTruthy()
    expect(screen.getByText('Completed issue')).toBeTruthy()
    expect(screen.getByText('Cancelled issue')).toBeTruthy()

    // Each issue should have a status dropdown
    const selects = document.querySelectorAll("[data-slot='select-trigger']")
    expect(selects.length).toBe(4)
  })

  it('preserves creation order (insertion order from LiveStore)', () => {
    useLaborerStoreMock.mockReturnValue({
      useQuery: () => [
        {
          id: 'task-1',
          projectId: 'project-1',
          source: 'prd',
          prdId: 'prd-1',
          title: 'First issue',
          status: 'pending',
          externalId: '1',
        },
        {
          id: 'task-2',
          projectId: 'project-1',
          source: 'prd',
          prdId: 'prd-1',
          title: 'Second issue',
          status: 'pending',
          externalId: '2',
        },
        {
          id: 'task-3',
          projectId: 'project-1',
          source: 'prd',
          prdId: 'prd-1',
          title: 'Third issue',
          status: 'pending',
          externalId: '3',
        },
      ],
    })

    const { container } = render(<PlanIssuesList prdId="prd-1" />)

    const titles = Array.from(
      container.querySelectorAll('span.truncate.text-sm')
    ).map((node) => node.textContent)

    expect(titles).toEqual(['First issue', 'Second issue', 'Third issue'])
  })

  it('shows externalId when present', () => {
    useLaborerStoreMock.mockReturnValue({
      useQuery: () => [
        {
          id: 'task-1',
          projectId: 'project-1',
          source: 'prd',
          prdId: 'prd-1',
          title: 'Issue with external id',
          status: 'pending',
          externalId: 'prd-issue-42',
        },
      ],
    })

    render(<PlanIssuesList prdId="prd-1" />)

    expect(screen.getByText('prd-issue-42')).toBeTruthy()
  })

  it('does not show externalId when null', () => {
    useLaborerStoreMock.mockReturnValue({
      useQuery: () => [
        {
          id: 'task-1',
          projectId: 'project-1',
          source: 'prd',
          prdId: 'prd-1',
          title: 'Issue without external id',
          status: 'pending',
          externalId: null,
        },
      ],
    })

    render(<PlanIssuesList prdId="prd-1" />)

    expect(screen.getByText('Issue without external id')).toBeTruthy()
    // No monospace external id text should be present
    const monoSpans = document.querySelectorAll('span.font-mono')
    expect(monoSpans.length).toBe(0)
  })
})
