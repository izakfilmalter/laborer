import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import {
  LabelSettings,
  type LabelSettingsRow,
} from '@/components/labels/label-settings'

// Base UI positions its popups against measured anchors, which jsdom does not
// implement. The tests care about what the popup offers, not where it lands.
beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    disconnect() {
      // no-op
    }
    observe() {
      // no-op
    }
    unobserve() {
      // no-op
    }
  }
})

afterEach(cleanup)

const JANUARY_2026 = Date.UTC(2026, 0, 15)

const APP_WIDE_NOTE = /shared across every project/
const EDIT_LABEL_NAME_ITEM = /Edit label name/
const NEW_LABEL_BUTTON = /New label/

const row = (
  name: string,
  overrides: Partial<LabelSettingsRow> = {}
): LabelSettingsRow => ({
  color: 'blue',
  createdAt: JANUARY_2026,
  id: `label-${name.toLowerCase()}`,
  name,
  taskCount: 0,
  ...overrides,
})

const renderSettings = (
  overrides: Partial<React.ComponentProps<typeof LabelSettings>> = {}
) => {
  const props = {
    labels: [row('Worship'), row('Admin', { taskCount: 3 })],
    onCreate: vi.fn(),
    onDelete: vi.fn(),
    onRecolor: vi.fn(),
    onRename: vi.fn(),
    ...overrides,
  }
  render(<LabelSettings {...props} />)
  return props
}

const rowFor = (name: string) =>
  screen.getByRole('button', { name }).closest('tr') as HTMLElement

/**
 * Base UI opens a menu on pointer down and toggles it on the click that
 * follows, which user-event replays as both — leaving the menu closed. A plain
 * click event is the one sequence that reaches the trigger intact under jsdom.
 */
const openRowMenu = (name: string) => {
  fireEvent.click(
    within(rowFor(name)).getByRole('button', { name: 'Open label actions' })
  )
}

describe('label settings', () => {
  it('lists every label by name, counting the tasks that carry each', () => {
    renderSettings()

    // The table speaks for the whole app, so it names no project.
    expect(screen.getByText(APP_WIDE_NOTE)).toBeTruthy()

    const names = screen
      .getAllByRole('row')
      .slice(1)
      .map((tableRow) => within(tableRow).getAllByRole('cell')[0]?.textContent)
    expect(names).toEqual(['Admin', 'Worship'])

    // A label no task carries reads as a dash rather than a zero.
    expect(within(rowFor('Admin')).getAllByRole('cell')[1]?.textContent).toBe(
      '3'
    )
    expect(within(rowFor('Worship')).getAllByRole('cell')[1]?.textContent).toBe(
      '\u2014'
    )
  })

  it('says so when there are no labels at all', () => {
    renderSettings({ labels: [] })

    expect(screen.getByText('No labels yet.')).toBeTruthy()
  })

  it('narrows the table to the labels matching the filter', async () => {
    const user = userEvent.setup()
    renderSettings()

    await user.type(
      screen.getByRole('textbox', { name: 'Filter labels by name' }),
      'wor'
    )

    expect(screen.getByRole('button', { name: 'Worship' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Admin' })).toBeNull()
  })

  it('says so when the filter matches nothing', async () => {
    const user = userEvent.setup()
    renderSettings()

    await user.type(
      screen.getByRole('textbox', { name: 'Filter labels by name' }),
      'zzz'
    )

    expect(screen.getByText('No labels match that name.')).toBeTruthy()
  })

  it('commits an inline rename on Enter', async () => {
    const user = userEvent.setup()
    const props = renderSettings()

    await user.click(screen.getByRole('button', { name: 'Worship' }))
    const input = screen.getByRole('textbox', { name: 'Label name' })
    await user.clear(input)
    await user.type(input, 'Worship Team{Enter}')

    expect(props.onRename).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Worship' }),
      'Worship Team'
    )
  })

  it('abandons an inline rename on Escape', async () => {
    const user = userEvent.setup()
    const props = renderSettings()

    await user.click(screen.getByRole('button', { name: 'Worship' }))
    const input = screen.getByRole('textbox', { name: 'Label name' })
    await user.clear(input)
    await user.type(input, 'Worship Team{Escape}')

    expect(props.onRename).not.toHaveBeenCalled()
    // The row reads as its stored name again.
    expect(screen.getByRole('button', { name: 'Worship' })).toBeTruthy()
  })

  it('leaves a rename that changed nothing alone', async () => {
    const user = userEvent.setup()
    const props = renderSettings()

    await user.click(screen.getByRole('button', { name: 'Worship' }))
    await user.type(
      screen.getByRole('textbox', { name: 'Label name' }),
      '{Enter}'
    )

    expect(props.onRename).not.toHaveBeenCalled()
  })

  it('recolors a label from the swatch popover', async () => {
    const user = userEvent.setup()
    const props = renderSettings()

    await user.click(
      screen.getByRole('button', { name: 'Change color of Worship' })
    )
    await user.click(screen.getByRole('button', { name: 'emerald' }))

    expect(props.onRecolor).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Worship' }),
      'emerald'
    )
  })

  it('deletes a label from the row menu without a confirmation step', async () => {
    const user = userEvent.setup()
    const props = renderSettings()

    openRowMenu('Worship')
    await user.click(screen.getByRole('menuitem', { name: 'Delete' }))

    expect(props.onDelete).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Worship' })
    )
    // Deleting is immediate; nothing stands between the menu and the write.
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('starts a rename from the row menu', async () => {
    const user = userEvent.setup()
    renderSettings()

    openRowMenu('Worship')
    await user.click(
      screen.getByRole('menuitem', { name: EDIT_LABEL_NAME_ITEM })
    )

    expect(
      (screen.getByRole('textbox', { name: 'Label name' }) as HTMLInputElement)
        .value
    ).toBe('Worship')
  })

  it('renames on E while the row menu owns the keyboard', () => {
    renderSettings()

    openRowMenu('Admin')
    // The shortcut is scoped to the open popup, so the key is delivered there
    // rather than to the document the way a global binding would be.
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'e' })

    expect(
      (screen.getByRole('textbox', { name: 'Label name' }) as HTMLInputElement)
        .value
    ).toBe('Admin')
  })

  it('creates a label from the row pinned above the table', async () => {
    const user = userEvent.setup()
    const props = renderSettings()

    await user.click(screen.getByRole('button', { name: NEW_LABEL_BUTTON }))
    await user.type(
      screen.getByRole('textbox', { name: 'New label name' }),
      'Docs{Enter}'
    )

    expect(props.onCreate).toHaveBeenCalledWith('Docs')
  })

  it('surfaces a rejected write above the table', () => {
    renderSettings({ error: 'This label changed elsewhere.' })

    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain('This label changed elsewhere.')
  })
})
