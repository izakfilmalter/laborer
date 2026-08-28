import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  CommandPaletteActionItem,
  CommandPaletteGroup,
} from '@/components/command-palette/command-palette.logic'
import { CommandPaletteContent } from '@/components/command-palette/command-palette-content'
import { CommandPaletteResults } from '@/components/command-palette/command-palette-results'

afterEach(cleanup)

const action = (
  overrides: Partial<CommandPaletteActionItem> & { readonly value: string }
): CommandPaletteActionItem => ({
  icon: null,
  kind: 'action',
  run: () => undefined,
  searchTerms: [overrides.value],
  title: overrides.value,
  ...overrides,
})

function renderPalette(input: {
  readonly groups: readonly CommandPaletteGroup[]
  readonly onExecuteItem?: (item: CommandPaletteActionItem) => void
}) {
  return render(
    <CommandPaletteContent
      inputProps={{ placeholder: 'Search commands and workspaces...' }}
      mode="none"
      onValueChange={() => undefined}
      value=""
    >
      <CommandPaletteResults
        groups={input.groups}
        highlightedItemValue={null}
        onExecuteItem={(item) => {
          if (item.kind === 'action') {
            input.onExecuteItem?.(item)
          }
        }}
      />
    </CommandPaletteContent>
  )
}

describe('CommandPaletteResults', () => {
  it('renders group labels, items, and shortcut hints', () => {
    renderPalette({
      groups: [
        {
          items: [
            action({
              shortcut: { key: 'k', meta: true, shift: true },
              title: 'Toggle task board',
              value: 'action:toggle-board',
            }),
          ],
          label: 'Actions',
          value: 'actions',
        },
      ],
    })

    expect(screen.getByText('Actions')).toBeDefined()
    expect(screen.getByText('Toggle task board')).toBeDefined()
    // jsdom has no mac navigator.platform, so the label is the non-mac form.
    expect(screen.getByText('Shift+Meta+K')).toBeDefined()
  })

  it('executes an item on click', () => {
    const onExecuteItem = vi.fn()
    renderPalette({
      groups: [
        {
          items: [action({ title: 'Push workspace', value: 'action:push' })],
          label: 'Actions',
          value: 'actions',
        },
      ],
      onExecuteItem,
    })

    fireEvent.click(screen.getByText('Push workspace'))

    expect(onExecuteItem).toHaveBeenCalledTimes(1)
    expect(onExecuteItem.mock.calls[0]?.[0]?.value).toBe('action:push')
  })

  it('renders disabled items without an interactive option row', () => {
    const onExecuteItem = vi.fn()
    renderPalette({
      groups: [
        {
          items: [
            action({
              disabled: true,
              title: 'Pull workspace',
              value: 'action:pull',
            }),
          ],
          label: 'Actions',
          value: 'actions',
        },
      ],
      onExecuteItem,
    })

    fireEvent.click(screen.getByText('Pull workspace'))

    expect(onExecuteItem).not.toHaveBeenCalled()
    expect(screen.queryByRole('option')).toBeNull()
  })

  it('shows the empty state when no groups match', () => {
    renderPalette({ groups: [] })

    expect(screen.getByText('No matching commands.')).toBeDefined()
  })
})
