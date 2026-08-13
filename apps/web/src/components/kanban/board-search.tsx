import { Search, X } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { Input } from '@/components/ui/input'

/** Local search input for the board toolbar. */
function BoardSearch({
  value,
  onChange,
  open,
}: {
  readonly value: string
  readonly onChange: (value: string) => void
  readonly open: boolean
}) {
  const inputRef = useRef<HTMLInputElement>(null)

  // The board overlay stays mounted (hidden via CSS) while dismissed, so
  // mount-time autoFocus would fire once against a display:none input and
  // never again. Focus follows the overlay opening instead.
  useEffect(() => {
    if (open) {
      inputRef.current?.focus()
    }
  }, [open])

  const handleClear = () => {
    onChange('')
    inputRef.current?.focus()
  }

  return (
    <div className="relative w-64">
      <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input
        aria-label="Search cards"
        className="h-7 pr-7 pl-7"
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && value.length > 0) {
            event.preventDefault()
            handleClear()
          }
        }}
        placeholder="Search cards..."
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

export { BoardSearch }
