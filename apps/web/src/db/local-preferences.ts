import { type WindowLayout, WindowLayoutSchema } from '@laborer/shared/types'
import { createCollection, localStorageCollectionOptions } from '@tanstack/db'
import { Schema } from 'effect'
import { z } from 'zod'

export const LOCAL_COLLECTIONS = {
  boardHeight: {
    id: 'laborer.local.board-overlay-height.v1',
    storageKey: 'laborer:db:board-overlay-height:v1',
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
  workspaceExpansion: {
    id: 'laborer.local.workspace-expansion.v1',
    storageKey: 'laborer:db:workspace-expansion:v1',
  },
} as const

const singletonPreferenceSchema = z.object({
  id: z.literal('current'),
  value: z.number().finite(),
})
export type SingletonPreference = z.infer<typeof singletonPreferenceSchema>

const expansionSchema = z.object({
  id: z.string().min(1),
  expanded: z.boolean(),
})
export type ExpansionPreference = z.infer<typeof expansionSchema>

const panelLayoutSchema = z.object({
  id: z.string().min(1),
  layout: z.custom<WindowLayout>((value) =>
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
export const sidebarWidthCollection = createCollection(
  localStorageCollectionOptions({
    ...LOCAL_COLLECTIONS.sidebarWidth,
    getKey: (row: SingletonPreference) => row.id,
    parser: makeValidatedLocalStorageParser(singletonPreferenceSchema),
    schema: singletonPreferenceSchema,
  })
)
export const boardOverlayHeightCollection = createCollection(
  localStorageCollectionOptions({
    ...LOCAL_COLLECTIONS.boardHeight,
    getKey: (row: SingletonPreference) => row.id,
    parser: makeValidatedLocalStorageParser(singletonPreferenceSchema),
    schema: singletonPreferenceSchema,
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
export const workspaceExpansionCollection = createCollection(
  localStorageCollectionOptions({
    ...LOCAL_COLLECTIONS.workspaceExpansion,
    getKey: (row: ExpansionPreference) => row.id,
    parser: makeValidatedLocalStorageParser(expansionSchema),
    schema: expansionSchema,
  })
)

export const setSingletonPreference = (
  collection:
    | typeof sidebarWidthCollection
    | typeof boardOverlayHeightCollection,
  value: number
): void => {
  if (collection.has('current')) {
    collection.update('current', (draft) => {
      draft.value = value
    })
  } else {
    collection.insert({ id: 'current', value })
  }
}

export const setExpansionPreference = (
  collection:
    | typeof projectExpansionCollection
    | typeof workspaceExpansionCollection,
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
