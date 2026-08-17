import type { WindowLayout } from '@laborer/shared/types'
import { createCollection, localStorageCollectionOptions } from '@tanstack/db'
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
  layout: z.custom<WindowLayout>(),
})
export type PanelLayoutPreference = z.infer<typeof panelLayoutSchema>

export const panelLayoutCollection = createCollection(
  localStorageCollectionOptions({
    ...LOCAL_COLLECTIONS.panelLayouts,
    getKey: (row: PanelLayoutPreference) => row.id,
    schema: panelLayoutSchema,
  })
)
export const sidebarWidthCollection = createCollection(
  localStorageCollectionOptions({
    ...LOCAL_COLLECTIONS.sidebarWidth,
    getKey: (row: SingletonPreference) => row.id,
    schema: singletonPreferenceSchema,
  })
)
export const boardOverlayHeightCollection = createCollection(
  localStorageCollectionOptions({
    ...LOCAL_COLLECTIONS.boardHeight,
    getKey: (row: SingletonPreference) => row.id,
    schema: singletonPreferenceSchema,
  })
)
export const projectExpansionCollection = createCollection(
  localStorageCollectionOptions({
    ...LOCAL_COLLECTIONS.projectExpansion,
    getKey: (row: ExpansionPreference) => row.id,
    schema: expansionSchema,
  })
)
export const workspaceExpansionCollection = createCollection(
  localStorageCollectionOptions({
    ...LOCAL_COLLECTIONS.workspaceExpansion,
    getKey: (row: ExpansionPreference) => row.id,
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
