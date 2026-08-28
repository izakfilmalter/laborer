import type { ReactNode } from 'react'
import type { CreateWorkspaceIntent } from '@/hooks/use-create-workspace'
import type { Keybind } from '@/lib/keybinds'

export const ACTIONS_GROUP_VALUE = 'actions'

interface CommandPaletteItem {
  readonly description?: string | undefined
  readonly disabled?: boolean | undefined
  readonly icon: ReactNode
  readonly searchTerms: readonly string[]
  readonly shortcut?: Keybind | undefined
  readonly title: string
  readonly value: string
}

export interface CommandPaletteActionItem extends CommandPaletteItem {
  readonly keepOpen?: boolean | undefined
  readonly kind: 'action'
  readonly run: () => void | Promise<void>
}

export interface CommandPaletteSubmenuItem extends CommandPaletteItem {
  readonly groups: readonly CommandPaletteGroup[]
  readonly kind: 'submenu'
}

export type CommandPaletteEntry =
  | CommandPaletteActionItem
  | CommandPaletteSubmenuItem

export interface CommandPaletteGroup {
  readonly items: readonly CommandPaletteEntry[]
  readonly label: string
  readonly value: string
}

export type CommandPaletteView =
  | {
      readonly groups: readonly CommandPaletteGroup[]
      readonly kind: 'items'
      readonly title: string
    }
  | {
      readonly kind: 'create-workspace'
      readonly projectId: string
      readonly projectName: string
    }

const normalizeSearchText = (value: string): string =>
  value.trim().toLowerCase().replace(/\s+/g, ' ')

const rankSearchFieldMatch = (
  field: string,
  normalizedQuery: string
): number => {
  const normalizedField = normalizeSearchText(field)
  if (!normalizedField.includes(normalizedQuery)) {
    return Number.NEGATIVE_INFINITY
  }
  if (normalizedField === normalizedQuery) {
    return 3
  }
  if (normalizedField.startsWith(normalizedQuery)) {
    return 2
  }
  return 1
}

const rankItemMatch = (
  item: CommandPaletteEntry,
  normalizedQuery: string
): number => {
  for (const [index, field] of item.searchTerms.entries()) {
    const fieldRank = rankSearchFieldMatch(field, normalizedQuery)
    if (fieldRank !== Number.NEGATIVE_INFINITY) {
      return 1000 - index * 100 + fieldRank
    }
  }
  return 0
}

/**
 * Filter each group independently while preserving group order. Prefixing a
 * query with `>` narrows the root palette to actions, matching command-palette
 * conventions without making the prefix part of the search term.
 */
export function filterCommandPaletteGroups(input: {
  readonly groups: readonly CommandPaletteGroup[]
  readonly query: string
}): CommandPaletteGroup[] {
  const actionsOnly = input.query.startsWith('>')
  const query = actionsOnly ? input.query.slice(1) : input.query
  const normalizedQuery = normalizeSearchText(query)
  const groups = actionsOnly
    ? input.groups.filter((group) => group.value === ACTIONS_GROUP_VALUE)
    : input.groups

  if (normalizedQuery === '') {
    return [...groups]
  }

  return groups.flatMap((group) => {
    const items = group.items
      .map((item, index) => ({
        index,
        item,
        rank: rankItemMatch(item, normalizedQuery),
        searchableText: normalizeSearchText(item.searchTerms.join(' ')),
      }))
      .filter((entry) => entry.searchableText.includes(normalizedQuery))
      .toSorted(
        (left, right) => right.rank - left.rank || left.index - right.index
      )
      .map((entry) => entry.item)

    return items.length === 0 ? [] : [{ ...group, items }]
  })
}

export function buildCreateWorkspaceGroup(input: {
  readonly branchName: string
  readonly icon: ReactNode
  readonly intent: CreateWorkspaceIntent
  readonly projectName: string
  readonly query: string
  readonly run: () => void | Promise<void>
}): CommandPaletteGroup[] {
  const copyByIntent: Record<
    CreateWorkspaceIntent,
    { readonly description: string; readonly title: string }
  > = {
    branch: {
      description: `in ${input.projectName}`,
      title: `Create “${input.branchName}”`,
    },
    empty: {
      description: `in ${input.projectName}`,
      title: 'Create an auto-named workspace',
    },
    slack: {
      description: `in ${input.projectName}`,
      title: 'Create from this Slack thread',
    },
    'unrecognized-link': {
      description: 'The link is not a recognized Slack message URL',
      title: 'Try this link anyway',
    },
  }
  const copy = copyByIntent[input.intent]

  return [
    {
      items: [
        {
          ...copy,
          icon: input.icon,
          kind: 'action',
          run: input.run,
          searchTerms: [input.query, input.branchName, input.projectName],
          value: `create-workspace:${input.projectName}`,
        },
      ],
      label: 'Create workspace',
      value: 'create-workspace',
    },
  ]
}
