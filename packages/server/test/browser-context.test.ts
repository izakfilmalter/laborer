import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import { BrowserContext } from '../src/services/browser-context.js'

const annotation = {
  id: 'annotation-1',
  comment: 'Make this clearer',
  createdAt: '2026-08-28T00:00:00.000Z',
  pageTitle: 'Home',
  pageUrl: 'http://localhost:3000/',
  elements: [],
  regions: [],
  strokes: [],
  styleChanges: [],
  screenshot: {
    cropRect: { x: 0, y: 0, width: 1, height: 1 },
    dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
    width: 1,
    height: 1,
  },
} as const

describe('BrowserContext', () => {
  it.effect('persists scoped artifacts and consumption state', () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() =>
        mkdtemp(join(tmpdir(), 'laborer-browser-context-'))
      )
      const previousRoot = process.env.LABORER_BROWSER_CONTEXT_ROOT
      process.env.LABORER_BROWSER_CONTEXT_ROOT = root
      const program = Effect.gen(function* () {
        const context = yield* BrowserContext
        const delivered = yield* context.deliver('workspace-1', annotation)
        expect(
          delivered.annotation.screenshot?.artifactPath.startsWith(root)
        ).toBe(true)
        const screenshot = delivered.annotation.screenshot
        if (!screenshot) {
          throw new Error('Expected a persisted screenshot')
        }
        expect(
          yield* Effect.promise(() => readFile(screenshot.artifactPath))
        ).toEqual(Buffer.from('89504e470d0a1a0a', 'hex'))
        expect(yield* context.list('workspace-2')).toEqual([])
        expect(yield* context.list('workspace-1')).toHaveLength(1)
        const invalid = yield* Effect.flip(
          context.deliver('workspace-1', {
            ...annotation,
            id: 'annotation-invalid',
            screenshot: {
              ...annotation.screenshot,
              dataUrl: 'data:image/png;base64,aGVsbG8=',
            },
          })
        )
        expect(invalid.code).toBe('INVALID_ARTIFACT')
        expect(
          (yield* context.consume('workspace-1', delivered.id)).state
        ).toBe('consumed')
        expect(yield* context.list('workspace-1')).toEqual([])
      }).pipe(Effect.provide(BrowserContext.layer))
      yield* program.pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (previousRoot === undefined) {
              Reflect.deleteProperty(
                process.env,
                'LABORER_BROWSER_CONTEXT_ROOT'
              )
            } else {
              process.env.LABORER_BROWSER_CONTEXT_ROOT = previousRoot
            }
          })
        )
      )
    })
  )
})
