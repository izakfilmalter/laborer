/**
 * The Labels settings table.
 *
 * Presentational on purpose, the same way `LabelsPicker` is: it owns the
 * filter, the sort, the inline rename, the swatch popover, and the create row,
 * but not where labels come from or how a write is sent. `LabelSettingsSection`
 * supplies both.
 *
 * Labels belong to one project root path, so this surface always speaks about
 * a single named project rather than the whole app.
 */

'use client'

import { LABEL_COLORS, labelColorForName } from '@laborer/shared/labels'
import type { LabelColor } from '@laborer/shared/rpc'
import {
  Check,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Trash2,
} from 'lucide-react'
import type { ReactElement, ReactNode } from 'react'
import { useState } from 'react'

import { Alert, AlertDescription } from '@laborer/ui/components/alert'
import { Button } from '@laborer/ui/components/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@laborer/ui/components/dropdown-menu'
import { Input } from '@laborer/ui/components/input'
import { Kbd } from '@laborer/ui/components/kbd'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@laborer/ui/components/popover'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@laborer/ui/components/table'
import { cn } from '@laborer/ui/lib/utils'

import { labelColorDotClassName, labelDotClassName } from './label-colors'

/** A label as the settings table consumes it. */
export interface LabelSettingsRow {
  readonly color: string
  /** Epoch milliseconds, as the shared row stores it. */
  readonly createdAt: number
  readonly id: string
  readonly name: string
  /** How many of the project's tasks carry this label. */
  readonly taskCount: number
}

type SortColumn = 'createdAt' | 'name' | 'taskCount'

/** The table's columns and how each one orders and measures. */
const COLUMNS: ReadonlyArray<{
  readonly column: SortColumn
  readonly headClassName?: string
  readonly label: string
}> = [
  { column: 'name', label: 'Name' },
  { column: 'taskCount', headClassName: 'w-24', label: 'Tasks' },
  { column: 'createdAt', headClassName: 'w-28', label: 'Created' },
]

/** Columns, plus the trailing actions cell the header leaves unnamed. */
const COLUMN_COUNT = COLUMNS.length + 1

const MONTH_AND_YEAR = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  year: 'numeric',
})

const formatCreated = (createdAt: number): string =>
  Number.isFinite(createdAt) ? MONTH_AND_YEAR.format(new Date(createdAt)) : '—'

const compareBy = (
  column: SortColumn,
  left: LabelSettingsRow,
  right: LabelSettingsRow
): number => {
  if (column === 'name') {
    return left.name.localeCompare(right.name)
  }
  // Ties in a numeric column would otherwise shuffle on every render, so the
  // name settles them and the table stays stable while you read it.
  return left[column] - right[column] || left.name.localeCompare(right.name)
}

export interface LabelSettingsProps {
  /** The most recent rejected write, shown above the table until it succeeds. */
  readonly error?: string | null
  readonly labels: readonly LabelSettingsRow[]
  readonly onCreate: (name: string) => void
  readonly onDelete: (label: LabelSettingsRow) => void
  readonly onRecolor: (label: LabelSettingsRow, color: LabelColor) => void
  readonly onRename: (label: LabelSettingsRow, name: string) => void
}

export function LabelSettings({
  error = null,
  labels,
  onCreate,
  onDelete,
  onRecolor,
  onRename,
}: LabelSettingsProps): ReactElement {
  const [filter, setFilter] = useState('')
  const [creating, setCreating] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [sort, setSort] = useState<{
    readonly column: SortColumn
    readonly descending: boolean
  }>({ column: 'name', descending: false })

  const query = filter.trim().toLowerCase()
  const visible = labels
    .filter((label) => label.name.toLowerCase().includes(query))
    .sort((left, right) => {
      const order = compareBy(sort.column, left, right)
      return sort.descending ? -order : order
    })

  const toggleSort = (column: SortColumn) => {
    setSort((current) =>
      current.column === column
        ? { column, descending: !current.descending }
        : { column, descending: false }
    )
  }

  return (
    <section className="space-y-4">
      <div>
        <h3 className="font-medium text-sm">Labels</h3>
        <p className="text-muted-foreground text-sm">
          Labels are shared across every project and workspace.
        </p>
      </div>

      <div className="flex items-center justify-between gap-3">
        <div className="relative w-full max-w-xs">
          <Search className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            aria-label="Filter labels by name"
            className="pl-8"
            onChange={(event) => setFilter(event.currentTarget.value)}
            placeholder="Filter by name..."
            value={filter}
          />
        </div>
        <Button
          disabled={creating}
          onClick={() => setCreating(true)}
          type="button"
        >
          <Plus />
          New label
        </Button>
      </div>

      {error === null ? null : (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="max-h-72 overflow-y-auto">
        <Table>
          <TableHeader>
            <TableRow>
              {COLUMNS.map(({ column, headClassName, label }) => (
                <TableHead className={headClassName} key={column}>
                  <button
                    aria-label={`Sort by ${label.toLowerCase()}`}
                    className="-mx-1 rounded-sm px-1 py-0.5 text-muted-foreground transition-colors hover:text-foreground"
                    onClick={() => toggleSort(column)}
                    type="button"
                  >
                    {label}
                  </button>
                </TableHead>
              ))}
              <TableHead className="w-10">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {creating ? (
              <NewLabelRow
                onCancel={() => setCreating(false)}
                onSubmit={(name) => {
                  setCreating(false)
                  const trimmed = name.trim()
                  if (trimmed !== '') {
                    onCreate(trimmed)
                  }
                }}
              />
            ) : null}
            {visible.map((label) => (
              <LabelRow
                editing={editingId === label.id}
                key={label.id}
                label={label}
                onDelete={() => onDelete(label)}
                onEdit={() => setEditingId(label.id)}
                onRecolor={(color) => onRecolor(label, color)}
                onRenameCancel={() => setEditingId(null)}
                onRenameCommit={(name) => {
                  setEditingId(null)
                  const trimmed = name.trim()
                  if (trimmed !== '' && trimmed !== label.name) {
                    onRename(label, trimmed)
                  }
                }}
              />
            ))}
            {visible.length === 0 && !creating ? (
              <TableRow className="hover:bg-transparent">
                <TableCell
                  className="py-6 text-center text-muted-foreground"
                  colSpan={COLUMN_COUNT}
                >
                  {labels.length === 0
                    ? 'No labels yet.'
                    : 'No labels match that name.'}
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      </div>
    </section>
  )
}

function LabelRow({
  editing,
  label,
  onDelete,
  onEdit,
  onRecolor,
  onRenameCancel,
  onRenameCommit,
}: {
  readonly editing: boolean
  readonly label: LabelSettingsRow
  readonly onDelete: () => void
  readonly onEdit: () => void
  readonly onRecolor: (color: LabelColor) => void
  readonly onRenameCancel: () => void
  readonly onRenameCommit: (name: string) => void
}): ReactElement {
  return (
    <TableRow className="group/row">
      <TableCell>
        <div className="flex min-w-0 items-center gap-3">
          <LabelColorPicker
            color={label.color}
            name={label.name}
            onSelect={onRecolor}
          />
          {editing ? (
            <LabelNameInput
              defaultValue={label.name}
              onCancel={onRenameCancel}
              onSubmit={onRenameCommit}
            />
          ) : (
            <button
              className="flex h-8 w-56 items-center truncate rounded-lg border border-transparent px-2.5 text-left text-sm transition-colors hover:border-input hover:bg-background"
              onClick={onEdit}
              type="button"
            >
              {label.name}
            </button>
          )}
        </div>
      </TableCell>
      <TableCell className="text-muted-foreground tabular-nums">
        {label.taskCount > 0 ? label.taskCount : '—'}
      </TableCell>
      <TableCell className="text-muted-foreground">
        {formatCreated(label.createdAt)}
      </TableCell>
      <TableCell className="text-right">
        <LabelRowActions onDelete={onDelete} onRename={onEdit} />
      </TableCell>
    </TableRow>
  )
}

/** The inline "create a label" row pinned to the top of the table body. */
function NewLabelRow({
  onCancel,
  onSubmit,
}: {
  readonly onCancel: () => void
  readonly onSubmit: (name: string) => void
}): ReactElement {
  const [name, setName] = useState('')
  const trimmed = name.trim()
  // The preview uses the same derivation the server applies when a create
  // omits a color, so the dot does not change color once the row lands.
  const color = trimmed === '' ? 'blue' : labelColorForName(trimmed)

  return (
    <TableRow className="bg-muted/40 hover:bg-muted/40">
      <TableCell colSpan={COLUMN_COUNT}>
        <div className="flex items-center gap-3">
          <span
            className={cn(
              'size-2.5 shrink-0 rounded-full',
              labelColorDotClassName(color)
            )}
          />
          <LabelNameInput
            defaultValue=""
            label="New label name"
            onCancel={onCancel}
            onSubmit={onSubmit}
            onValueChange={setName}
          />
        </div>
      </TableCell>
    </TableRow>
  )
}

/**
 * A small text field that commits on Enter and on blur, and cancels on Escape.
 * Blur commits because clicking away from a rename you just typed reads as
 * accepting it, not as discarding it.
 */
function LabelNameInput({
  defaultValue,
  label = 'Label name',
  onCancel,
  onSubmit,
  onValueChange,
}: {
  readonly defaultValue: string
  readonly label?: string
  readonly onCancel: () => void
  readonly onSubmit: (name: string) => void
  readonly onValueChange?: (value: string) => void
}): ReactElement {
  const [value, setValue] = useState(defaultValue)
  // Escape has to suppress the blur commit that follows it, or cancelling
  // would immediately be undone by the field losing focus.
  const [cancelled, setCancelled] = useState(false)

  return (
    <Input
      aria-label={label}
      // An inline editor exists to be typed into, so it takes focus on mount.
      autoFocus
      className="h-8 w-56 text-sm"
      onBlur={() => {
        if (!cancelled) {
          onSubmit(value)
        }
      }}
      onChange={(event) => {
        setValue(event.currentTarget.value)
        onValueChange?.(event.currentTarget.value)
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          onSubmit(value)
          return
        }
        if (event.key === 'Escape') {
          event.preventDefault()
          setCancelled(true)
          onCancel()
        }
      }}
      placeholder="Label name"
      value={value}
    />
  )
}

/** The color dot, which opens a popover of selectable swatches. */
function LabelColorPicker({
  color,
  name,
  onSelect,
}: {
  readonly color: string
  readonly name: string
  readonly onSelect: (color: LabelColor) => void
}): ReactElement {
  const [open, setOpen] = useState(false)

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger
        aria-label={`Change color of ${name}`}
        className="rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <span
          className={cn(
            'block size-2.5 shrink-0 rounded-full',
            labelDotClassName({ color, name })
          )}
        />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto flex-row gap-1.5 p-1.5">
        {LABEL_COLORS.map((swatch) => (
          <button
            aria-label={swatch}
            className="flex size-7 items-center justify-center rounded-full transition-colors hover:bg-muted"
            key={swatch}
            onClick={() => {
              onSelect(swatch)
              setOpen(false)
            }}
            type="button"
          >
            <span
              className={cn(
                'flex size-5 items-center justify-center rounded-full text-white',
                labelColorDotClassName(swatch)
              )}
            >
              {swatch === color ? <Check className="size-3.5" /> : null}
            </span>
          </button>
        ))}
      </PopoverContent>
    </Popover>
  )
}

/**
 * The trailing per-row "..." menu. The "E" shortcut is scoped to the open
 * popup rather than bound globally: while the menu is open focus is trapped
 * inside it, so the key can only mean "rename this row".
 */
function LabelRowActions({
  onDelete,
  onRename,
}: {
  readonly onDelete: () => void
  readonly onRename: () => void
}): ReactNode {
  const [open, setOpen] = useState(false)

  return (
    <DropdownMenu onOpenChange={setOpen} open={open}>
      <DropdownMenuTrigger
        render={
          <Button
            aria-label="Open label actions"
            className="opacity-0 group-hover/row:opacity-100 aria-expanded:opacity-100"
            size="icon-sm"
            variant="ghost"
          />
        }
      >
        <MoreHorizontal />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="min-w-44"
        onKeyDown={(event) => {
          if (
            event.key.toLowerCase() === 'e' &&
            !(event.metaKey || event.ctrlKey || event.altKey)
          ) {
            event.preventDefault()
            setOpen(false)
            onRename()
          }
        }}
        side="bottom"
      >
        <DropdownMenuItem className="whitespace-nowrap" onClick={onRename}>
          <Pencil />
          Edit label name
          <DropdownMenuShortcut>
            <Kbd>E</Kbd>
          </DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={onDelete} variant="destructive">
          <Trash2 />
          Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
