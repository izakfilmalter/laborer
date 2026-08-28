/**
 * Grouped command palette result list, ported from t3code.
 *
 * Row highlight is controlled by the palette (`highlightedItemValue` from
 * Base UI's `onItemHighlighted`) so keyboard and pointer highlight share
 * one visual state.
 */

import { cn } from '@laborer/ui/lib/utils'
import { ChevronRightIcon } from 'lucide-react'
import { formatKeybind } from '@/lib/keybinds'
import {
  CommandCollection,
  CommandGroup,
  CommandGroupLabel,
  CommandItem,
  CommandList,
  CommandShortcut,
} from './command'
import type {
  CommandPaletteEntry,
  CommandPaletteGroup,
} from './command-palette.logic'

interface CommandPaletteResultsProps {
  readonly groups: readonly CommandPaletteGroup[]
  readonly highlightedItemValue: string | null
  readonly onExecuteItem: (item: CommandPaletteEntry) => void
}

export function CommandPaletteResults(props: CommandPaletteResultsProps) {
  if (props.groups.length === 0) {
    return (
      <div className="py-10 text-center text-muted-foreground text-sm">
        No matching commands.
      </div>
    )
  }

  return (
    <CommandList>
      {props.groups.map((group) => (
        <CommandGroup items={group.items} key={group.value}>
          <CommandGroupLabel>{group.label}</CommandGroupLabel>
          <CommandCollection>
            {(item: CommandPaletteEntry) =>
              item.disabled ? (
                <DisabledResultRow item={item} key={item.value} />
              ) : (
                <ResultRow
                  isActive={props.highlightedItemValue === item.value}
                  item={item}
                  key={item.value}
                  onExecuteItem={props.onExecuteItem}
                />
              )
            }
          </CommandCollection>
        </CommandGroup>
      ))}
    </CommandList>
  )
}

function ResultRowBody(props: { readonly item: CommandPaletteEntry }) {
  return (
    <>
      {props.item.icon}
      {props.item.description ? (
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-foreground text-sm">
            {props.item.title}
          </span>
          <span className="min-w-0 truncate text-muted-foreground/70 text-xs">
            {props.item.description}
          </span>
        </span>
      ) : (
        <span className="min-w-0 flex-1 truncate text-foreground text-sm">
          {props.item.title}
        </span>
      )}
    </>
  )
}

function DisabledResultRow(props: { readonly item: CommandPaletteEntry }) {
  return (
    <div className="flex min-h-8 select-none items-center gap-2 rounded-sm px-2 py-1.5 text-base opacity-64 sm:min-h-7 sm:text-sm">
      <ResultRowBody item={props.item} />
    </div>
  )
}

function ResultRow(props: {
  readonly isActive: boolean
  readonly item: CommandPaletteEntry
  readonly onExecuteItem: (item: CommandPaletteEntry) => void
}) {
  return (
    <CommandItem
      className={cn(
        'cursor-pointer gap-2',
        props.isActive && 'bg-accent text-accent-foreground'
      )}
      onClick={() => {
        props.onExecuteItem(props.item)
      }}
      onMouseDown={(event) => {
        // Keep focus in the palette input so typing continues to filter.
        event.preventDefault()
      }}
      value={props.item.value}
    >
      <ResultRowBody item={props.item} />
      {props.item.shortcut && (
        <CommandShortcut>{formatKeybind(props.item.shortcut)}</CommandShortcut>
      )}
      {props.item.kind === 'submenu' && (
        <ChevronRightIcon className="ms-auto -me-0.5 size-4 shrink-0 text-muted-foreground/70" />
      )}
    </CommandItem>
  )
}
