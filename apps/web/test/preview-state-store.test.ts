import type { PreviewSessionSnapshot } from '@laborer/shared/rpc'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  emptyWorkspacePreviewState,
  previewRuntimeTabId,
  usePreviewStateStore,
} from '@/preview-state-store'

const snapshot = (
  workspaceId: string,
  tabId: string,
  updatedAt = '2026-01-01T00:00:00.000Z'
): PreviewSessionSnapshot => ({
  workspaceId,
  tabId,
  updatedAt,
  canGoBack: false,
  canGoForward: false,
  navStatus: {
    _tag: 'Success',
    title: tabId,
    url: `http://localhost/${tabId}`,
  },
})

describe('preview state reconciliation', () => {
  beforeEach(() => {
    usePreviewStateStore.setState({ byWorkspaceId: {} })
  })

  it('reconstructs sessions without duplicating them and preserves the active tab', () => {
    const store = usePreviewStateStore.getState()
    store.reconcile('workspace-a', {
      serverEpoch: 'epoch-a',
      revision: 2,
      sessions: [
        snapshot('workspace-a', 'one'),
        snapshot('workspace-a', 'two'),
      ],
    })
    store.setActive('workspace-a', 'one')
    store.reconcile('workspace-a', {
      serverEpoch: 'epoch-a',
      revision: 3,
      sessions: [
        snapshot('workspace-a', 'one'),
        snapshot('workspace-a', 'two'),
      ],
    })

    const state = usePreviewStateStore.getState().byWorkspaceId['workspace-a']
    expect(Object.keys(state?.sessions ?? {})).toEqual(['one', 'two'])
    expect(state?.activeTabId).toBe('one')
  })

  it('rejects stale revisions and old-epoch events after daemon restart', () => {
    usePreviewStateStore.getState().reconcile('workspace-a', {
      serverEpoch: 'new',
      revision: 8,
      sessions: [snapshot('workspace-a', 'new-tab')],
    })
    usePreviewStateStore.getState().applyEvent({
      type: 'opened',
      workspaceId: 'workspace-a',
      tabId: 'old-tab',
      createdAt: '2026-01-01T00:00:00.000Z',
      serverEpoch: 'old',
      revision: 99,
      snapshot: snapshot('workspace-a', 'old-tab'),
    })
    usePreviewStateStore.getState().reconcile('workspace-a', {
      serverEpoch: 'new',
      revision: 7,
      sessions: [snapshot('workspace-a', 'stale-tab')],
    })
    expect(
      Object.keys(
        usePreviewStateStore.getState().byWorkspaceId['workspace-a']
          ?.sessions ?? {}
      )
    ).toEqual(['new-tab'])
  })

  it('suppresses an intentionally closed tab until the authoritative close arrives', () => {
    usePreviewStateStore.getState().reconcile('workspace-a', {
      serverEpoch: 'epoch',
      revision: 1,
      sessions: [snapshot('workspace-a', 'tab')],
    })
    usePreviewStateStore.getState().beginClose('workspace-a', 'tab')
    usePreviewStateStore.getState().reconcile('workspace-a', {
      serverEpoch: 'epoch',
      revision: 2,
      sessions: [snapshot('workspace-a', 'tab')],
    })
    expect(
      usePreviewStateStore.getState().byWorkspaceId['workspace-a']?.sessions
    ).toEqual({})
    usePreviewStateStore.getState().applyEvent({
      type: 'closed',
      workspaceId: 'workspace-a',
      tabId: 'tab',
      createdAt: '2026-01-01T00:00:01.000Z',
      serverEpoch: 'epoch',
      revision: 3,
    })
    expect(
      usePreviewStateStore.getState().byWorkspaceId['workspace-a']
        ?.suppressedTabIds.size
    ).toBe(0)
  })

  it('isolates workspaces and desktop runtime ids', () => {
    usePreviewStateStore
      .getState()
      .upsert('workspace-a', snapshot('workspace-a', 'tab'))
    expect(
      usePreviewStateStore.getState().byWorkspaceId['workspace-b']
    ).toBeUndefined()
    expect(previewRuntimeTabId('workspace-a', 'epoch', 'tab')).not.toBe(
      previewRuntimeTabId('workspace-b', 'epoch', 'tab')
    )
    expect(emptyWorkspacePreviewState.sessions).toEqual({})
  })
})
