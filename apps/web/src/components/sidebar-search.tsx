/**
 * Sidebar search input component.
 *
 * A text input with a search icon and a clear button (X icon) that filters
 * the sidebar project tree in real-time. The search query is controlled by
 * the parent component.
 *
 * @see Issue #171: Replace ProjectSwitcher with search bar
 */

import { Search, X } from 'lucide-react'
import type { KeyboardEvent } from 'react'
import { useCallback, useRef } from 'react'
import { Input } from '@/components/ui/input'

interface SidebarSearchProps {
  /** Called when the user types in the search input. */
  readonly onChange: (value: string) => void
  /** The current search query. */
  readonly value: string
}

function SidebarSearch({ value, onChange }: SidebarSearchProps) {
  const inputRef = useRef<HTMLInputElement>(null)

  const handleClear = useCallback(() => {
    onChange('')
    inputRef.current?.focus()
  }, [onChange])

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Escape' && value.length > 0) {
        e.preventDefault()
        handleClear()
      }
    },
    [value, handleClear]
  )

  return (
    <div className="relative">
      <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input
        aria-label="Search projects and workspaces"
        className="pr-7 pl-7"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Search projects..."
        ref={inputRef}
        type="text"
        value={value}
      />
      {value.length > 0 && (
        <button
          aria-label="Clear search"
          className="absolute top-1/2 right-1.5 flex size-5 -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={handleClear}
          type="button"
        >
          <X className="size-3.5" />
        </button>
      )}
    </div>
  )
}

export { SidebarSearch }
export type { SidebarSearchProps }
