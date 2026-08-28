import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type {
  BrowserAnnotation,
  BrowserContextItem,
} from '@laborer/shared/browser-control'
import {
  BrowserContextError,
  BrowserContextItem as BrowserContextItemSchema,
} from '@laborer/shared/browser-control'
import { taskDatabasePath } from '@laborer/task-db/path'
import { Context, Effect, Layer, Schema, SynchronizedRef } from 'effect'

const DATA_URL = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/
const PNG_SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex')

export class BrowserContext extends Context.Service<
  BrowserContext,
  {
    readonly deliver: (
      workspaceId: string,
      annotation: BrowserAnnotation
    ) => Effect.Effect<BrowserContextItem, BrowserContextError>
    readonly list: (
      workspaceId: string,
      includeConsumed?: boolean
    ) => Effect.Effect<readonly BrowserContextItem[], BrowserContextError>
    readonly consume: (
      workspaceId: string,
      id: string
    ) => Effect.Effect<BrowserContextItem, BrowserContextError>
  }
>()('@laborer/server/BrowserContext') {
  static readonly layer = Layer.effect(
    BrowserContext,
    Effect.gen(function* () {
      const root = resolve(
        process.env.LABORER_BROWSER_CONTEXT_ROOT ??
          join(dirname(taskDatabasePath()), 'browser-context')
      )
      const lock = yield* SynchronizedRef.make(0)
      const fileFor = (workspaceId: string) =>
        join(root, Buffer.from(workspaceId).toString('base64url'), 'inbox.json')
      const load = (workspaceId: string) =>
        Effect.tryPromise({
          try: async () =>
            JSON.parse(await readFile(fileFor(workspaceId), 'utf8')),
          catch: (cause) =>
            (cause as NodeJS.ErrnoException).code === 'ENOENT'
              ? new BrowserContextError({
                  code: 'NOT_FOUND',
                  message: 'Browser context inbox is empty',
                })
              : new BrowserContextError({
                  code: 'IO_FAILED',
                  message: 'Unable to read browser context inbox',
                }),
        }).pipe(
          Effect.flatMap(
            Schema.decodeUnknownEffect(Schema.Array(BrowserContextItemSchema))
          ),
          Effect.mapError((error) =>
            error instanceof BrowserContextError
              ? error
              : new BrowserContextError({
                  code: 'IO_FAILED',
                  message: 'Browser context inbox is corrupt',
                })
          ),
          Effect.catchTag('BrowserContextError', (error) =>
            error.code === 'NOT_FOUND' ? Effect.succeed([]) : error
          )
        )
      const save = (
        workspaceId: string,
        items: readonly BrowserContextItem[]
      ) =>
        Effect.tryPromise({
          try: async () => {
            const path = fileFor(workspaceId)
            await mkdir(dirname(path), { recursive: true })
            const temporary = `${path}.${process.pid}.tmp`
            await writeFile(temporary, JSON.stringify(items, null, 2), {
              mode: 0o600,
            })
            await rename(temporary, path)
          },
          catch: () =>
            new BrowserContextError({
              code: 'IO_FAILED',
              message: 'Unable to persist browser context inbox',
            }),
        })
      const synchronized = <A>(effect: Effect.Effect<A, BrowserContextError>) =>
        SynchronizedRef.modifyEffect(lock, (value) =>
          effect.pipe(Effect.map((result) => [result, value + 1] as const))
        )

      const deliver = Effect.fn('BrowserContext.deliver')(
        (workspaceId: string, annotation: BrowserAnnotation) =>
          synchronized(
            Effect.gen(function* () {
              const dir = dirname(fileFor(workspaceId))
              let screenshot: BrowserContextItem['annotation']['screenshot'] =
                null
              if (annotation.screenshot) {
                const match = DATA_URL.exec(annotation.screenshot.dataUrl)
                if (!match?.[1]) {
                  return yield* new BrowserContextError({
                    code: 'INVALID_ARTIFACT',
                    message: 'Annotation screenshot is not a PNG data URL',
                  })
                }
                const artifactPath = join(
                  dir,
                  'artifacts',
                  `${annotation.id}.png`
                )
                const artifact = Buffer.from(match[1], 'base64')
                if (
                  !artifact
                    .subarray(0, PNG_SIGNATURE.length)
                    .equals(PNG_SIGNATURE)
                ) {
                  return yield* new BrowserContextError({
                    code: 'INVALID_ARTIFACT',
                    message: 'Annotation screenshot does not contain PNG data',
                  })
                }
                yield* Effect.tryPromise({
                  try: async () => {
                    await mkdir(dirname(artifactPath), { recursive: true })
                    await writeFile(artifactPath, artifact, { mode: 0o600 })
                  },
                  catch: () =>
                    new BrowserContextError({
                      code: 'IO_FAILED',
                      message: 'Unable to persist annotation screenshot',
                    }),
                })
                screenshot = {
                  artifactPath,
                  mimeType: 'image/png',
                  width: annotation.screenshot.width,
                  height: annotation.screenshot.height,
                }
              }
              const now = new Date().toISOString()
              const item: BrowserContextItem = {
                id: annotation.id,
                workspaceId,
                annotation: { ...annotation, screenshot },
                state: 'pending',
                deliveredAt: now,
                consumedAt: null,
              }
              const items = yield* load(workspaceId)
              const next = [...items.filter(({ id }) => id !== item.id), item]
              yield* save(workspaceId, next)
              return item
            })
          )
      )
      const list = Effect.fn('BrowserContext.list')(
        (workspaceId: string, includeConsumed = false) =>
          load(workspaceId).pipe(
            Effect.map((items) =>
              items.filter(
                (item) => includeConsumed || item.state === 'pending'
              )
            )
          )
      )
      const consume = Effect.fn('BrowserContext.consume')(
        (workspaceId: string, id: string) =>
          synchronized(
            Effect.gen(function* () {
              const items = yield* load(workspaceId)
              const item = items.find((candidate) => candidate.id === id)
              if (!item) {
                return yield* new BrowserContextError({
                  code: 'NOT_FOUND',
                  message: `Browser context item not found: ${id}`,
                })
              }
              const consumed: BrowserContextItem = {
                ...item,
                state: 'consumed',
                consumedAt: new Date().toISOString(),
              }
              const next = items.map((candidate) =>
                candidate.id === id ? consumed : candidate
              )
              yield* save(workspaceId, next)
              return consumed
            })
          )
      )
      return BrowserContext.of({ deliver, list, consume })
    })
  )
}
