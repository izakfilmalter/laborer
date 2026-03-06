import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Track mutation→function mapping using the mutation key itself.
// Everything must be hoisted so it's available during vi.mock factories.
const { readPrdFn, updatePrdFn, mutationMap } = vi.hoisted(() => {
  const rFn = vi.fn()
  const uFn = vi.fn()
  return {
    readPrdFn: rFn,
    updatePrdFn: uFn,
    mutationMap: new Map<unknown, ReturnType<typeof vi.fn>>(),
  }
})

vi.mock('@effect-atom/atom-react/Hooks', () => ({
  useAtomSet: (atom: unknown) => {
    return mutationMap.get(atom) ?? vi.fn()
  },
}))

vi.mock('@/atoms/laborer-client', () => ({
  LaborerClient: {
    mutation: (name: string) => {
      // Return a unique sentinel per RPC name
      const sentinel = Symbol.for(`mutation:${name}`)
      if (name === 'prd.read') {
        mutationMap.set(sentinel, readPrdFn)
      }
      if (name === 'prd.update') {
        mutationMap.set(sentinel, updatePrdFn)
      }
      return sentinel
    },
  },
}))

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}))

// Plate.js mocks — avoid loading the real editor in jsdom
vi.mock('platejs/react', () => ({
  Plate: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="plate-editor">{children}</div>
  ),
  PlateContent: ({
    placeholder,
  }: {
    placeholder?: string
    onBlur?: () => void
    className?: string
  }) => <div data-testid="plate-content">{placeholder}</div>,
  PlateElement: ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  ),
  PlateLeaf: ({ children }: { children?: React.ReactNode }) => (
    <span>{children}</span>
  ),
  usePlateEditor: () => ({
    api: {
      markdown: {
        serialize: vi.fn(() => '# Serialized content'),
        deserialize: vi.fn(() => [{ type: 'p', children: [{ text: 'test' }] }]),
      },
    },
    getApi: () => ({
      markdown: {
        deserialize: () => [{ type: 'p', children: [{ text: 'test' }] }],
      },
    }),
  }),
}))

vi.mock('@platejs/basic-nodes/react', () => ({
  BlockquotePlugin: { withComponent: () => ({}) },
  BoldPlugin: { withComponent: () => ({}) },
  CodePlugin: { withComponent: () => ({}) },
  H1Plugin: { withComponent: () => ({}) },
  H2Plugin: { withComponent: () => ({}) },
  H3Plugin: { withComponent: () => ({}) },
  H4Plugin: { withComponent: () => ({}) },
  H5Plugin: { withComponent: () => ({}) },
  H6Plugin: { withComponent: () => ({}) },
  ItalicPlugin: { withComponent: () => ({}) },
  StrikethroughPlugin: { withComponent: () => ({}) },
}))

vi.mock('@platejs/code-block/react', () => ({
  CodeBlockPlugin: { withComponent: () => ({}) },
  CodeLinePlugin: { withComponent: () => ({}) },
}))

vi.mock('@platejs/link/react', () => ({
  LinkPlugin: { withComponent: () => ({}) },
}))

vi.mock('@platejs/list/react', () => ({
  ListPlugin: {},
}))

vi.mock('@platejs/markdown', () => ({
  MarkdownPlugin: { configure: () => ({}) },
}))

vi.mock('@platejs/table/react', () => ({
  TablePlugin: { withComponent: () => ({}) },
  TableRowPlugin: { withComponent: () => ({}) },
  TableCellPlugin: { withComponent: () => ({}) },
}))

vi.mock('remark-gfm', () => ({ default: () => ({}) }))

import { PlanEditor } from '../src/components/plan-editor'

describe('PlanEditor', () => {
  afterEach(() => {
    cleanup()
  })

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('shows loading state initially', () => {
    // Never resolves — keeps the editor in loading state
    // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional pending promise
    readPrdFn.mockReturnValue(new Promise(() => {}))

    render(<PlanEditor onBack={vi.fn()} prdId="prd-1" />)

    const spinner = document.querySelector('.animate-spin')
    expect(spinner).toBeTruthy()
  })

  it('shows error state when loading fails', async () => {
    readPrdFn.mockRejectedValue(new Error('PRD not found'))

    render(<PlanEditor onBack={vi.fn()} prdId="prd-1" />)

    await waitFor(() => {
      expect(screen.getByText('PRD not found')).toBeTruthy()
    })

    expect(screen.getByText('Go back')).toBeTruthy()
  })

  it('renders editor with PRD title after loading', async () => {
    readPrdFn.mockResolvedValue({
      id: 'prd-1',
      projectId: 'project-1',
      title: 'My Test PRD',
      slug: 'my-test-prd',
      filePath: '/path/to/prd.md',
      status: 'draft',
      createdAt: '2026-03-06T10:00:00Z',
      content: '# Hello World\n\nThis is a test PRD.',
    })

    render(<PlanEditor onBack={vi.fn()} prdId="prd-1" />)

    await waitFor(() => {
      expect(screen.getByText('My Test PRD')).toBeTruthy()
    })

    expect(screen.getByText('Saved')).toBeTruthy()
    expect(screen.getByTestId('plate-editor')).toBeTruthy()
  })

  it('calls onBack when back button is clicked', async () => {
    readPrdFn.mockResolvedValue({
      id: 'prd-1',
      projectId: 'project-1',
      title: 'Test PRD',
      slug: 'test-prd',
      filePath: '/path/to/prd.md',
      status: 'draft',
      createdAt: '2026-03-06T10:00:00Z',
      content: '# Test',
    })

    const onBack = vi.fn()
    render(<PlanEditor onBack={onBack} prdId="prd-1" />)

    await waitFor(() => {
      expect(screen.getByText('Test PRD')).toBeTruthy()
    })

    const backButton = screen.getByRole('button', { name: 'Back to panels' })
    backButton.click()
    expect(onBack).toHaveBeenCalledOnce()
  })

  it('calls onBack from error state via Go back button', async () => {
    readPrdFn.mockRejectedValue(new Error('Network error'))

    const onBack = vi.fn()
    render(<PlanEditor onBack={onBack} prdId="prd-1" />)

    await waitFor(() => {
      expect(screen.getByText('Network error')).toBeTruthy()
    })

    screen.getByText('Go back').click()
    expect(onBack).toHaveBeenCalledOnce()
  })

  it('calls prd.read with the correct prdId on mount', async () => {
    readPrdFn.mockResolvedValue({
      id: 'prd-42',
      projectId: 'project-1',
      title: 'Specific PRD',
      slug: 'specific-prd',
      filePath: '/path.md',
      status: 'active',
      createdAt: '2026-03-06T10:00:00Z',
      content: '# Content',
    })

    render(<PlanEditor onBack={vi.fn()} prdId="prd-42" />)

    await waitFor(() => {
      expect(screen.getByText('Specific PRD')).toBeTruthy()
    })

    expect(readPrdFn).toHaveBeenCalledWith({
      payload: { prdId: 'prd-42' },
    })
  })
})
