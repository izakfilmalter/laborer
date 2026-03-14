/**
 * Lightweight panel type picker component shown when creating a new panel
 * (via split or new tab). Displays a numbered list of available panel types
 * with keyboard navigation support.
 *
 * Interaction:
 * - Arrow keys (up/down) to navigate with wrapping
 * - Number keys (1-4) to select directly
 * - Enter to confirm selection
 * - Escape to cancel
 * - Mouse click to select
 *
 * The picker returns the selected panel type to the caller via `onSelect`.
 * It does not create the panel itself.
 *
 * @see docs/tabbed-window-layout/issues.md — Issue #11
 */

import type { PaneType } from '@laborer/shared/types'
import { Eye, FileCode2, Server, Terminal } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A panel type option displayed in the picker. */
interface PanelTypeOption {
  /** Icon rendered beside the label. */
  readonly icon: React.ReactNode
  /** Display label. */
  readonly label: string
  /** The pane type value. */
  readonly type: PaneType
}

/** Props for the PanelTypePicker component. */
interface PanelTypePickerProps {
  /** Additional CSS classes for the root container. */
  readonly className?: string | undefined
  /** Called when the picker is cancelled (Escape or click outside). */
  readonly onCancel: () => void
  /** Called when a panel type is selected. */
  readonly onSelect: (type: PaneType) => void
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

const PANEL_TYPE_OPTIONS: readonly PanelTypeOption[] = [
  {
    type: 'terminal',
    label: 'Terminal',
    icon: <Terminal className="size-4" />,
  },
  { type: 'diff', label: 'Diff', icon: <FileCode2 className="size-4" /> },
  { type: 'review', label: 'Review', icon: <Eye className="size-4" /> },
  {
    type: 'devServerTerminal',
    label: 'Dev Server',
    icon: <Server className="size-4" />,
  },
] as const

// ---------------------------------------------------------------------------
// PanelTypePicker
// ---------------------------------------------------------------------------

function PanelTypePicker({
  onSelect,
  onCancel,
  className,
}: PanelTypePickerProps) {
  // Terminal (index 0) is pre-selected
  const [highlightedIndex, setHighlightedIndex] = useState(0)
  const containerRef = useRef<HTMLDivElement | null>(null)

  // Focus the container on mount to capture keyboard events
  useEffect(() => {
    containerRef.current?.focus()
  }, [])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      switch (e.key) {
        case 'ArrowDown': {
          e.preventDefault()
          setHighlightedIndex((prev) => (prev + 1) % PANEL_TYPE_OPTIONS.length)
          break
        }
        case 'ArrowUp': {
          e.preventDefault()
          setHighlightedIndex(
            (prev) =>
              (prev - 1 + PANEL_TYPE_OPTIONS.length) % PANEL_TYPE_OPTIONS.length
          )
          break
        }
        case 'Enter': {
          e.preventDefault()
          const option = PANEL_TYPE_OPTIONS[highlightedIndex]
          if (option) {
            onSelect(option.type)
          }
          break
        }
        case 'Escape': {
          e.preventDefault()
          onCancel()
          break
        }
        case '1':
        case '2':
        case '3':
        case '4': {
          e.preventDefault()
          const index = Number.parseInt(e.key, 10) - 1
          const option = PANEL_TYPE_OPTIONS[index]
          if (option) {
            onSelect(option.type)
          }
          break
        }
        default:
          break
      }
    },
    [highlightedIndex, onSelect, onCancel]
  )

  return (
    <div
      className={cn(
        'flex min-w-40 flex-col bg-popover py-1 text-popover-foreground shadow-md ring-1 ring-foreground/10',
        className
      )}
      data-testid="panel-type-picker"
      onKeyDown={handleKeyDown}
      ref={containerRef}
      role="listbox"
      tabIndex={0}
    >
      {PANEL_TYPE_OPTIONS.map((option, index) => (
        <div
          aria-selected={index === highlightedIndex}
          className={cn(
            'flex cursor-default select-none items-center gap-2 px-2 py-1.5 text-xs',
            index === highlightedIndex
              ? 'bg-accent text-accent-foreground'
              : 'text-popover-foreground hover:bg-muted/50'
          )}
          data-testid="panel-type-picker-option"
          key={option.type}
          onClick={() => onSelect(option.type)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              onSelect(option.type)
            }
          }}
          onMouseEnter={() => setHighlightedIndex(index)}
          role="option"
          tabIndex={-1}
        >
          <span className="flex w-4 shrink-0 items-center justify-center text-muted-foreground text-xs">
            {index + 1}
          </span>
          <span className="flex shrink-0 items-center">{option.icon}</span>
          <span>{option.label}</span>
        </div>
      ))}
    </div>
  )
}

export { PanelTypePicker, PANEL_TYPE_OPTIONS }
export type { PanelTypeOption, PanelTypePickerProps }
