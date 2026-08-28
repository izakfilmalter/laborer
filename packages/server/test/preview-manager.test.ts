import { describe, expect, it } from '@effect/vitest'
import { Effect, PubSub } from 'effect'
import {
  normalizePreviewUrl,
  PreviewManager,
} from '../src/services/preview-manager.js'

const SENSITIVE_URL_CONTENT = /password|access_token|secret|fragment/

const collectEvents = Effect.gen(function* () {
  const manager = yield* PreviewManager
  const subscription = yield* manager.subscribeEvents
  return { drain: PubSub.takeUpTo(subscription, 100) }
})

describe('PreviewManager', () => {
  it.effect('keeps sessions isolated by workspace and orders every event', () =>
    Effect.gen(function* () {
      const manager = yield* PreviewManager
      const events = yield* collectEvents
      const before = yield* manager.list('workspace-a')

      const first = yield* manager.open({
        workspaceId: 'workspace-a',
        url: 'localhost:5173',
      })
      yield* manager.navigate({
        workspaceId: 'workspace-a',
        tabId: first.tabId,
        url: 'http://localhost:5173/ready',
        resolvedTitle: 'Ready',
      })
      yield* manager.open({ workspaceId: 'workspace-b' })

      const a = yield* manager.list('workspace-a')
      const b = yield* manager.list('workspace-b')
      const published = yield* events.drain

      expect(a.sessions).toHaveLength(1)
      expect(b.sessions).toHaveLength(1)
      expect(a.sessions[0]?.workspaceId).toBe('workspace-a')
      expect(b.sessions[0]?.workspaceId).toBe('workspace-b')
      expect(published.map(({ type }) => type)).toEqual([
        'opened',
        'navigated',
        'opened',
      ])
      expect(published[0]?.revision).toBeGreaterThan(before.revision)
      expect(published[1]?.revision).toBeGreaterThan(
        published[0]?.revision ?? 0
      )
      expect(published[2]?.revision).toBeGreaterThan(
        published[1]?.revision ?? 0
      )
      expect(a.serverEpoch).toBe(b.serverEpoch)
      expect(b.revision).toBe(published[2]?.revision)
    }).pipe(Effect.provide(PreviewManager.layer))
  )

  it.effect(
    'persists viewport and renderer-reported navigation capabilities',
    () =>
      Effect.gen(function* () {
        const manager = yield* PreviewManager
        const opened = yield* manager.open({
          workspaceId: 'workspace',
          viewport: { _tag: 'freeform', width: 1024, height: 768 },
        })
        yield* manager.reportStatus({
          workspaceId: 'workspace',
          tabId: opened.tabId,
          navStatus: {
            _tag: 'Success',
            title: 'App',
            url: 'http://localhost:3000/',
          },
          canGoBack: true,
          canGoForward: false,
        })

        const listed = yield* manager.list('workspace')
        expect(listed.sessions[0]).toMatchObject({
          canGoBack: true,
          canGoForward: false,
          viewport: { _tag: 'freeform', width: 1024, height: 768 },
        })
      }).pipe(Effect.provide(PreviewManager.layer))
  )

  it.effect('persists failures and emits the t3 failed event shape', () =>
    Effect.gen(function* () {
      const manager = yield* PreviewManager
      const opened = yield* manager.open({
        workspaceId: 'workspace',
        url: 'localhost:3000',
      })
      const events = yield* collectEvents

      yield* manager.reportStatus({
        workspaceId: 'workspace',
        tabId: opened.tabId,
        navStatus: {
          _tag: 'LoadFailed',
          code: -105,
          description: 'ERR_NAME_NOT_RESOLVED',
          title: '',
          url: 'http://localhost:3000/',
        },
        canGoBack: false,
        canGoForward: false,
      })

      expect((yield* manager.list('workspace')).sessions[0]?.navStatus).toEqual(
        {
          _tag: 'LoadFailed',
          code: -105,
          description: 'ERR_NAME_NOT_RESOLVED',
          title: '',
          url: 'http://localhost:3000/',
        }
      )
      expect(yield* events.drain).toMatchObject([
        {
          code: -105,
          description: 'ERR_NAME_NOT_RESOLVED',
          type: 'failed',
        },
      ])
    }).pipe(Effect.provide(PreviewManager.layer))
  )

  it.effect(
    'emits one close per tab and removes only the target workspace',
    () =>
      Effect.gen(function* () {
        const manager = yield* PreviewManager
        yield* manager.open({ workspaceId: 'workspace-a' })
        yield* manager.open({ workspaceId: 'workspace-a' })
        yield* manager.open({ workspaceId: 'workspace-b' })
        const events = yield* collectEvents

        yield* manager.closeWorkspace('workspace-a')

        const published = yield* events.drain
        expect(published).toHaveLength(2)
        expect(published.every(({ type }) => type === 'closed')).toBe(true)
        expect(published[1]?.revision).toBeGreaterThan(
          published[0]?.revision ?? 0
        )
        expect((yield* manager.list('workspace-a')).sessions).toEqual([])
        expect((yield* manager.list('workspace-b')).sessions).toHaveLength(1)
      }).pipe(Effect.provide(PreviewManager.layer))
  )

  it.effect('rejects invalid URLs without retaining their contents', () =>
    Effect.gen(function* () {
      const raw =
        'https://user:password@example.com:bad/path?access_token=secret#fragment'
      const error = yield* Effect.flip(normalizePreviewUrl(raw))

      expect(error._tag).toBe('PreviewInvalidUrlError')
      expect(error.reason).toBe('parse')
      expect(error.protocol).toBe('https:')
      expect(error).not.toHaveProperty('rawUrl')
      expect(error.message).not.toMatch(SENSITIVE_URL_CONTENT)
    })
  )

  it.effect(
    'fails mutations for an unknown tab and keeps close idempotent',
    () =>
      Effect.gen(function* () {
        const manager = yield* PreviewManager
        const error = yield* Effect.flip(
          manager.refresh({ workspaceId: 'workspace', tabId: 'tab_missing' })
        )
        expect(error._tag).toBe('PreviewSessionLookupError')

        yield* manager.close({ workspaceId: 'workspace', tabId: 'tab_missing' })
        expect((yield* manager.list('workspace')).sessions).toEqual([])
      }).pipe(Effect.provide(PreviewManager.layer))
  )

  it.effect('cannot resurrect a tab after its browser resource closes', () =>
    Effect.gen(function* () {
      const manager = yield* PreviewManager
      const opened = yield* manager.open({ workspaceId: 'workspace' })
      yield* manager.close({
        workspaceId: 'workspace',
        tabId: opened.tabId,
      })

      const error = yield* Effect.flip(
        manager.reportStatus({
          workspaceId: 'workspace',
          tabId: opened.tabId,
          navStatus: { _tag: 'Idle' },
          canGoBack: false,
          canGoForward: false,
        })
      )

      expect(error._tag).toBe('PreviewSessionLookupError')
      expect((yield* manager.list('workspace')).sessions).toEqual([])
    }).pipe(Effect.provide(PreviewManager.layer))
  )
})
