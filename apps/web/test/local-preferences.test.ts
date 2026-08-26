import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  boardOverlayHeightCollection,
  diffViewCollection,
  LOCAL_COLLECTIONS,
  makeValidatedLocalStorageParser,
  projectExpansionCollection,
  sidebarWidthCollection,
  workspaceGroupExpansionCollection,
} from '@/db/local-preferences'

const preferenceSchema = z.object({
  id: z.literal('current'),
  value: z.number().finite(),
})

describe('local preference persistence boundary', () => {
  it('uses the versioned identities assigned to each preference', () => {
    expect(LOCAL_COLLECTIONS.sidebarWidth).toEqual({
      id: 'laborer.local.sidebar-width.v1',
      storageKey: 'laborer:db:sidebar-width:v1',
    })
    expect(LOCAL_COLLECTIONS.boardOverlayHeight).toEqual({
      id: 'laborer.local.board-overlay-height.v1',
      storageKey: 'laborer:db:board-overlay-height:v1',
    })
    expect(LOCAL_COLLECTIONS.projectExpansion).toEqual({
      id: 'laborer.local.project-expansion.v1',
      storageKey: 'laborer:db:project-expansion:v1',
    })
    expect(LOCAL_COLLECTIONS.workspaceGroupExpansion).toEqual({
      id: 'laborer.local.workspace-group-expansion.v1',
      storageKey: 'laborer:db:workspace-group-expansion:v1',
    })
    expect(LOCAL_COLLECTIONS.diffView).toEqual({
      id: 'laborer.local.diff-view.v1',
      storageKey: 'laborer:db:diff-view:v1',
    })
    expect(diffViewCollection.id).toBe(LOCAL_COLLECTIONS.diffView.id)
    expect(sidebarWidthCollection.id).toBe(LOCAL_COLLECTIONS.sidebarWidth.id)
    expect(boardOverlayHeightCollection.id).toBe(
      LOCAL_COLLECTIONS.boardOverlayHeight.id
    )
    expect(projectExpansionCollection.id).toBe(
      LOCAL_COLLECTIONS.projectExpansion.id
    )
    expect(workspaceGroupExpansionCollection.id).toBe(
      LOCAL_COLLECTIONS.workspaceGroupExpansion.id
    )
  })

  it('drops invalid rows from the TanStack DB storage envelope', () => {
    const parser = makeValidatedLocalStorageParser(preferenceSchema)
    const parsed = parser.parse(
      JSON.stringify({
        's:current': {
          data: { id: 'current', value: 'not-a-number' },
          versionKey: 'invalid',
        },
        's:valid': {
          data: { id: 'current', value: 420 },
          versionKey: 'valid',
        },
      })
    )

    expect(parsed).toEqual({
      's:valid': {
        data: { id: 'current', value: 420 },
        versionKey: 'valid',
      },
    })
  })

  it('attaches persisted-row validation to every preference collection', () => {
    const persisted = (data: unknown) =>
      JSON.stringify({
        's:current': { data, versionKey: 'invalid' },
      })

    expect(
      sidebarWidthCollection.config.parser?.parse(
        persisted({ id: 'current', widthPx: 'wide' })
      )
    ).toEqual({})
    expect(
      boardOverlayHeightCollection.config.parser?.parse(
        persisted({ fraction: 'tall', id: 'current' })
      )
    ).toEqual({})
    expect(
      projectExpansionCollection.config.parser?.parse(
        persisted({ expanded: 'collapsed', id: 'project-1' })
      )
    ).toEqual({})
    expect(
      workspaceGroupExpansionCollection.config.parser?.parse(
        persisted({ expanded: 'collapsed', id: 'workspace-1' })
      )
    ).toEqual({})
    expect(
      diffViewCollection.config.parser?.parse(
        persisted({ id: 'workspace-1', ignoreWhitespace: 'yes', targetKey: '' })
      )
    ).toEqual({})
  })

  it('leaves malformed envelopes for the adapter to reject as empty', () => {
    const parser = makeValidatedLocalStorageParser(preferenceSchema)

    expect(parser.parse('[]')).toEqual([])
    expect(() => parser.parse('{')).toThrow()
  })
})
