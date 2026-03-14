/**
 * Tests for the PanelTypePicker presentational component.
 *
 * Verifies rendering of numbered items with icons, keyboard navigation
 * (arrow keys, number keys, Enter, Escape), mouse interaction, and
 * pre-selection of the terminal option.
 *
 * @see apps/web/src/components/ui/panel-type-picker.tsx
 * @see docs/tabbed-window-layout/issues.md — Issue #11
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Mocks — must be before component import
// ---------------------------------------------------------------------------

// Stub haptics to avoid web-haptics dependency in jsdom
vi.mock('@/lib/haptics', () => ({
  haptics: { buttonTap: vi.fn(), heavyImpact: vi.fn() },
}))

// ---------------------------------------------------------------------------
// Import component under test AFTER mocks
// ---------------------------------------------------------------------------

import {
  PANEL_TYPE_OPTIONS,
  PanelTypePicker,
} from '../src/components/ui/panel-type-picker'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderPicker(
  overrides: {
    className?: string
    onCancel?: () => void
    onSelect?: (type: string) => void
  } = {}
) {
  const onSelect = overrides.onSelect ?? vi.fn()
  const onCancel = overrides.onCancel ?? vi.fn()

  const result = render(
    <PanelTypePicker
      className={overrides.className}
      onCancel={onCancel}
      onSelect={onSelect}
    />
  )

  return { ...result, onSelect, onCancel }
}

function getPicker() {
  return screen.getByTestId('panel-type-picker')
}

function getOptions() {
  return screen.getAllByTestId('panel-type-picker-option')
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

afterEach(cleanup)

describe('PanelTypePicker', () => {
  // ---- Rendering ----

  describe('rendering', () => {
    it('renders a compact list with 4 items', () => {
      renderPicker()
      const options = getOptions()
      expect(options).toHaveLength(4)
    })

    it('renders numbered items with correct labels', () => {
      renderPicker()
      expect(screen.getByText('Terminal')).toBeTruthy()
      expect(screen.getByText('Diff')).toBeTruthy()
      expect(screen.getByText('Review')).toBeTruthy()
      expect(screen.getByText('Dev Server')).toBeTruthy()
    })

    it('renders number indicators 1-4', () => {
      renderPicker()
      expect(screen.getByText('1')).toBeTruthy()
      expect(screen.getByText('2')).toBeTruthy()
      expect(screen.getByText('3')).toBeTruthy()
      expect(screen.getByText('4')).toBeTruthy()
    })

    it('has role="listbox" on the container', () => {
      renderPicker()
      expect(screen.getByRole('listbox')).toBeTruthy()
    })

    it('has role="option" on each item', () => {
      renderPicker()
      const options = screen.getAllByRole('option')
      expect(options).toHaveLength(4)
    })

    it('applies additional className to the root element', () => {
      renderPicker({ className: 'custom-class' })
      const picker = getPicker()
      expect(picker.className).toContain('custom-class')
    })
  })

  // ---- Pre-selection ----

  describe('pre-selection', () => {
    it('terminal (first item) is pre-selected on open', () => {
      renderPicker()
      const options = screen.getAllByRole('option')
      expect(options[0]?.getAttribute('aria-selected')).toBe('true')
    })

    it('only one item is selected at a time', () => {
      renderPicker()
      const options = screen.getAllByRole('option')
      const selected = options.filter(
        (o) => o.getAttribute('aria-selected') === 'true'
      )
      expect(selected).toHaveLength(1)
    })

    it('non-terminal items are not pre-selected', () => {
      renderPicker()
      const options = screen.getAllByRole('option')
      for (let i = 1; i < options.length; i++) {
        expect(options[i]?.getAttribute('aria-selected')).toBe('false')
      }
    })
  })

  // ---- Arrow key navigation ----

  describe('arrow key navigation', () => {
    it('ArrowDown moves highlight to next item', () => {
      renderPicker()
      const picker = getPicker()
      fireEvent.keyDown(picker, { key: 'ArrowDown' })

      const options = screen.getAllByRole('option')
      expect(options[0]?.getAttribute('aria-selected')).toBe('false')
      expect(options[1]?.getAttribute('aria-selected')).toBe('true')
    })

    it('ArrowUp moves highlight to previous item', () => {
      renderPicker()
      const picker = getPicker()
      // Move down first, then up
      fireEvent.keyDown(picker, { key: 'ArrowDown' })
      fireEvent.keyDown(picker, { key: 'ArrowUp' })

      const options = screen.getAllByRole('option')
      expect(options[0]?.getAttribute('aria-selected')).toBe('true')
    })

    it('ArrowDown wraps from last to first item', () => {
      renderPicker()
      const picker = getPicker()
      // Move down 4 times (past the end)
      fireEvent.keyDown(picker, { key: 'ArrowDown' })
      fireEvent.keyDown(picker, { key: 'ArrowDown' })
      fireEvent.keyDown(picker, { key: 'ArrowDown' })
      fireEvent.keyDown(picker, { key: 'ArrowDown' })

      const options = screen.getAllByRole('option')
      expect(options[0]?.getAttribute('aria-selected')).toBe('true')
    })

    it('ArrowUp wraps from first to last item', () => {
      renderPicker()
      const picker = getPicker()
      fireEvent.keyDown(picker, { key: 'ArrowUp' })

      const options = screen.getAllByRole('option')
      expect(options[3]?.getAttribute('aria-selected')).toBe('true')
    })

    it('multiple ArrowDown presses navigate sequentially', () => {
      renderPicker()
      const picker = getPicker()
      fireEvent.keyDown(picker, { key: 'ArrowDown' })
      fireEvent.keyDown(picker, { key: 'ArrowDown' })

      const options = screen.getAllByRole('option')
      expect(options[2]?.getAttribute('aria-selected')).toBe('true')
    })
  })

  // ---- Number key direct selection ----

  describe('number key selection', () => {
    it('pressing 1 selects Terminal and calls onSelect', () => {
      const { onSelect } = renderPicker()
      const picker = getPicker()
      fireEvent.keyDown(picker, { key: '1' })
      expect(onSelect).toHaveBeenCalledWith('terminal')
    })

    it('pressing 2 selects Diff and calls onSelect', () => {
      const { onSelect } = renderPicker()
      const picker = getPicker()
      fireEvent.keyDown(picker, { key: '2' })
      expect(onSelect).toHaveBeenCalledWith('diff')
    })

    it('pressing 3 selects Review and calls onSelect', () => {
      const { onSelect } = renderPicker()
      const picker = getPicker()
      fireEvent.keyDown(picker, { key: '3' })
      expect(onSelect).toHaveBeenCalledWith('review')
    })

    it('pressing 4 selects Dev Server and calls onSelect', () => {
      const { onSelect } = renderPicker()
      const picker = getPicker()
      fireEvent.keyDown(picker, { key: '4' })
      expect(onSelect).toHaveBeenCalledWith('devServerTerminal')
    })

    it('pressing 5 does not call onSelect (no 5th option)', () => {
      const { onSelect } = renderPicker()
      const picker = getPicker()
      fireEvent.keyDown(picker, { key: '5' })
      expect(onSelect).not.toHaveBeenCalled()
    })

    it('pressing 0 does not call onSelect', () => {
      const { onSelect } = renderPicker()
      const picker = getPicker()
      fireEvent.keyDown(picker, { key: '0' })
      expect(onSelect).not.toHaveBeenCalled()
    })
  })

  // ---- Enter key ----

  describe('Enter key', () => {
    it('Enter confirms current highlight (Terminal by default)', () => {
      const { onSelect } = renderPicker()
      const picker = getPicker()
      fireEvent.keyDown(picker, { key: 'Enter' })
      expect(onSelect).toHaveBeenCalledWith('terminal')
    })

    it('Enter confirms after navigating to a different option', () => {
      const { onSelect } = renderPicker()
      const picker = getPicker()
      fireEvent.keyDown(picker, { key: 'ArrowDown' })
      fireEvent.keyDown(picker, { key: 'ArrowDown' })
      fireEvent.keyDown(picker, { key: 'Enter' })
      expect(onSelect).toHaveBeenCalledWith('review')
    })

    it('Enter confirms after navigating with ArrowUp wrap', () => {
      const { onSelect } = renderPicker()
      const picker = getPicker()
      fireEvent.keyDown(picker, { key: 'ArrowUp' })
      fireEvent.keyDown(picker, { key: 'Enter' })
      expect(onSelect).toHaveBeenCalledWith('devServerTerminal')
    })
  })

  // ---- Escape key ----

  describe('Escape key', () => {
    it('Escape closes without selection', () => {
      const { onSelect, onCancel } = renderPicker()
      const picker = getPicker()
      fireEvent.keyDown(picker, { key: 'Escape' })
      expect(onCancel).toHaveBeenCalledOnce()
      expect(onSelect).not.toHaveBeenCalled()
    })
  })

  // ---- Mouse interaction ----

  describe('mouse interaction', () => {
    it('clicking an option calls onSelect with the correct type', () => {
      const { onSelect } = renderPicker()
      const options = getOptions()
      fireEvent.click(options[1] as HTMLElement) // Click Diff
      expect(onSelect).toHaveBeenCalledWith('diff')
    })

    it('clicking the last option calls onSelect with devServerTerminal', () => {
      const { onSelect } = renderPicker()
      const options = getOptions()
      fireEvent.click(options[3] as HTMLElement) // Click Dev Server
      expect(onSelect).toHaveBeenCalledWith('devServerTerminal')
    })

    it('hovering an option updates the highlighted index', () => {
      renderPicker()
      const options = getOptions()
      fireEvent.mouseEnter(options[2] as HTMLElement) // Hover Review

      const allOptions = screen.getAllByRole('option')
      expect(allOptions[2]?.getAttribute('aria-selected')).toBe('true')
      expect(allOptions[0]?.getAttribute('aria-selected')).toBe('false')
    })

    it('hover then Enter selects the hovered item', () => {
      const { onSelect } = renderPicker()
      const options = getOptions()
      const picker = getPicker()

      fireEvent.mouseEnter(options[3] as HTMLElement) // Hover Dev Server
      fireEvent.keyDown(picker, { key: 'Enter' })
      expect(onSelect).toHaveBeenCalledWith('devServerTerminal')
    })
  })

  // ---- Focus ----

  describe('focus', () => {
    it('container has tabIndex=0 for keyboard focus', () => {
      renderPicker()
      const picker = getPicker()
      expect(picker.tabIndex).toBe(0)
    })
  })

  // ---- PANEL_TYPE_OPTIONS export ----

  describe('PANEL_TYPE_OPTIONS', () => {
    it('exports 4 panel type options', () => {
      expect(PANEL_TYPE_OPTIONS).toHaveLength(4)
    })

    it('has terminal as the first option', () => {
      expect(PANEL_TYPE_OPTIONS[0]?.type).toBe('terminal')
    })

    it('has correct types in order', () => {
      expect(PANEL_TYPE_OPTIONS.map((o) => o.type)).toEqual([
        'terminal',
        'diff',
        'review',
        'devServerTerminal',
      ])
    })

    it('has correct labels in order', () => {
      expect(PANEL_TYPE_OPTIONS.map((o) => o.label)).toEqual([
        'Terminal',
        'Diff',
        'Review',
        'Dev Server',
      ])
    })
  })
})
