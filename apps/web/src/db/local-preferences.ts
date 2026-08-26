import { type WindowLayout, WindowLayoutSchema } from '@laborer/shared/types'
import { createCollection, localStorageCollectionOptions } from '@tanstack/db'
import { Schema } from 'effect'
import { z } from 'zod'

export const LOCAL_COLLECTIONS = {
  boardOverlayHeight: {
    id: 'laborer.local.board-overlay-height.v1',
    storageKey: 'laborer:db:board-overlay-height:v1',
  },
  diffView: {
    id: 'laborer.local.diff-view.v1',
    storageKey: 'laborer:db:diff-view:v1',
  },
  panelLayouts: {
    id: 'laborer.local.panel-layouts.v1',
    storageKey: 'laborer:db:panel-layouts:v1',
  },
  projectExpansion: {
    id: 'laborer.local.project-expansion.v1',
    storageKey: 'laborer:db:project-expansion:v1',
  },
  sidebarWidth: {
    id: 'laborer.local.sidebar-width.v1',
    storageKey: 'laborer:db:sidebar-width:v1',
  },
  workspaceGroupExpansion: {
    id: 'laborer.local.workspace-group-expansion.v1',
    storageKey: 'laborer:db:workspace-group-expansion:v1',
  },
} as const

const sidebarWidthSchema = z.object({
  id: z.literal('current'),
  widthPx: z.number().finite(),
})
export type SidebarWidthPreference = z.infer<typeof sidebarWidthSchema>

const boardOverlayHeightSchema = z.object({
  fraction: z.number().finite(),
  id: z.literal('current'),
})
export type BoardOverlayHeightPreference = z.infer<
  typeof boardOverlayHeightSchema
>

const expansionSchema = z.object({
  id: z.string().min(1),
  expanded: z.boolean(),
})
export type ExpansionPreference = z.infer<typeof expansionSchema>

/**
 * What one workspace's diff pane is comparing, keyed by workspace id so
 * closing and reopening the pane — or opening a second one — lands back on
 * the same question.
 *
 * The target is stored as its key string rather than a nested union: the
 * key is already the pane's cache key and its menu value, and
 * `parseDiffTargetKey` is the one decoder that has to be tolerant of a
 * stale or hand-edited row.
 */
const diffViewSchema = z.object({
  id: z.string().min(1),
  ignoreWhitespace: z.boolean(),
  targetKey: z.string().min(1),
})
export type DiffViewPreference = z.infer<typeof diffViewSchema>

export const panelLayoutSchema = z.object({
  id: z.string().min(1),
  windowLayout: z.custom<WindowLayout>((value) =>
    Schema.is(WindowLayoutSchema)(value)
  ),
})
export type PanelLayoutPreference = z.infer<typeof panelLayoutSchema>

interface PersistedItem {
  readonly data: unknown
  readonly versionKey: unknown
}

const isPersistedItem = (value: unknown): value is PersistedItem =>
  typeof value === 'object' &&
  value !== null &&
  'data' in value &&
  'versionKey' in value

/**
 * TanStack DB 0.7 validates local mutations but does not validate rows loaded
 * from storage. Filter its versioned envelope before those rows enter a
 * collection so corrupt preferences degrade to their UI defaults.
 */
export const makeValidatedLocalStorageParser = <Output>(
  schema: z.ZodType<Output>
) => ({
  parse: (input: string): unknown => {
    const parsed: unknown = JSON.parse(input)
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return parsed
    }

    return Object.fromEntries(
      Object.entries(parsed).filter(
        ([, value]) =>
          isPersistedItem(value) && schema.safeParse(value.data).success
      )
    )
  },
  stringify: (value: unknown): string => JSON.stringify(value),
})

export const panelLayoutCollection = createCollection(
  localStorageCollectionOptions({
    ...LOCAL_COLLECTIONS.panelLayouts,
    getKey: (row: PanelLayoutPreference) => row.id,
    parser: makeValidatedLocalStorageParser(panelLayoutSchema),
    schema: panelLayoutSchema,
  })
)
export const diffViewCollection = createCollection(
  localStorageCollectionOptions({
    ...LOCAL_COLLECTIONS.diffView,
    getKey: (row: DiffViewPreference) => row.id,
    parser: makeValidatedLocalStorageParser(diffViewSchema),
    schema: diffViewSchema,
  })
)
export const sidebarWidthCollection = createCollection(
  localStorageCollectionOptions({
    ...LOCAL_COLLECTIONS.sidebarWidth,
    getKey: (row: SidebarWidthPreference) => row.id,
    parser: makeValidatedLocalStorageParser(sidebarWidthSchema),
    schema: sidebarWidthSchema,
  })
)
export const boardOverlayHeightCollection = createCollection(
  localStorageCollectionOptions({
    ...LOCAL_COLLECTIONS.boardOverlayHeight,
    getKey: (row: BoardOverlayHeightPreference) => row.id,
    parser: makeValidatedLocalStorageParser(boardOverlayHeightSchema),
    schema: boardOverlayHeightSchema,
  })
)
export const projectExpansionCollection = createCollection(
  localStorageCollectionOptions({
    ...LOCAL_COLLECTIONS.projectExpansion,
    getKey: (row: ExpansionPreference) => row.id,
    parser: makeValidatedLocalStorageParser(expansionSchema),
    schema: expansionSchema,
  })
)
export const workspaceGroupExpansionCollection = createCollection(
  localStorageCollectionOptions({
    ...LOCAL_COLLECTIONS.workspaceGroupExpansion,
    getKey: (row: ExpansionPreference) => row.id,
    parser: makeValidatedLocalStorageParser(expansionSchema),
    schema: expansionSchema,
  })
)

export const setSidebarWidthPreference = (widthPx: number): void => {
  if (sidebarWidthCollection.has('current')) {
    sidebarWidthCollection.update('current', (draft) => {
      draft.widthPx = widthPx
    })
  } else {
    sidebarWidthCollection.insert({ id: 'current', widthPx })
  }
}

export const setBoardOverlayHeightPreference = (fraction: number): void => {
  if (boardOverlayHeightCollection.has('current')) {
    boardOverlayHeightCollection.update('current', (draft) => {
      draft.fraction = fraction
    })
  } else {
    boardOverlayHeightCollection.insert({ fraction, id: 'current' })
  }
}

export const setDiffViewPreference = (
  workspaceId: string,
  preference: Omit<DiffViewPreference, 'id'>
): void => {
  if (diffViewCollection.has(workspaceId)) {
    diffViewCollection.update(workspaceId, (draft) => {
      draft.ignoreWhitespace = preference.ignoreWhitespace
      draft.targetKey = preference.targetKey
    })
  } else {
    diffViewCollection.insert({ ...preference, id: workspaceId })
  }
}

export const setPanelLayoutPreference = (
  id: string,
  windowLayout: WindowLayout
): void => {
  if (panelLayoutCollection.has(id)) {
    panelLayoutCollection.update(id, (draft) => {
      draft.windowLayout = structuredClone(
        windowLayout
      ) as typeof draft.windowLayout
    })
  } else {
    panelLayoutCollection.insert({ id, windowLayout })
  }
}

export const setExpansionPreference = (
  collection:
    | typeof projectExpansionCollection
    | typeof workspaceGroupExpansionCollection,
  id: string,
  expanded: boolean
): void => {
  if (collection.has(id)) {
    collection.update(id, (draft) => {
      draft.expanded = expanded
    })
  } else {
    collection.insert({ expanded, id })
  }
}
