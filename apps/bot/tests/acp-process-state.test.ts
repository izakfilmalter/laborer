import { readFile, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { assert, describe, it } from '@effect/vitest'
import { Effect } from 'effect'
import {
  AcpProcessStopRecord,
  makeAcpProcessStateRepository,
} from '../src/acp-runtime/acp-process-state.ts'
import { makeTempDirectoryScoped } from './support/temp-directory.ts'

describe('issue #252 durable ACP process state', () => {
  it.effect('publishes a monotonic generation before spawn can continue', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* makeTempDirectoryScoped('acp-process-state-')
        const path = join(root, 'acp-process-state.json')
        let observedNextGeneration = 0
        const repository = yield* makeAcpProcessStateRepository({
          path,
          testHooks: {
            afterGenerationPublished: async () => {
              const value = JSON.parse(await readFile(path, 'utf8')) as {
                readonly nextGeneration: number
              }
              observedNextGeneration = value.nextGeneration
            },
          },
          trustedRoot: root,
        })

        assert.strictEqual(yield* repository.reserveGeneration(10), 1)
        assert.strictEqual(observedNextGeneration, 2)

        const reopened = yield* makeAcpProcessStateRepository({
          path,
          trustedRoot: root,
        })
        assert.strictEqual(yield* reopened.reserveGeneration(20), 2)
        assert.strictEqual((yield* reopened.load).nextGeneration, 3)
      })
    )
  )

  it.effect(
    'bounds transitions and failures and retains only sanitized stop data',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped('acp-process-bounds-')
          const path = join(root, 'acp-process-state.json')
          const repository = yield* makeAcpProcessStateRepository({
            path,
            trustedRoot: root,
          })
          const generation = yield* repository.reserveGeneration(0)
          for (let index = 0; index < 80; index += 1) {
            yield* repository.transition({
              activeGeneration: generation,
              health: index % 2 === 0 ? 'restarting' : 'starting',
              timestamp: index + 1,
            })
          }
          for (let index = 0; index < 40; index += 1) {
            yield* repository.recordFailure({
              cause: 'process_exit',
              classification: 'transient',
              generation,
              timestamp: index + 1,
            })
          }
          yield* repository.recordStop(
            AcpProcessStopRecord.make({
              cause: 'process_exit',
              cleanupOutcome: 'completed',
              code: 1,
              expected: false,
              generation,
              phase: 'idle',
              signal: null,
              timestamp: 100,
            })
          )
          const state = yield* repository.load
          assert.strictEqual(state.transitions.length, 64)
          assert.strictEqual(state.failures.length, 32)
          assert.strictEqual(state.lastStop?.cause, 'process_exit')
          assert.strictEqual(state.lastStop?.cleanupOutcome, 'completed')
          assert.strictEqual(state.lastStop?.generation, 1)
          assert.strictEqual(state.lastStop?.phase, 'idle')
          const bytes = yield* Effect.promise(() => readFile(path))
          assert.ok(bytes.byteLength <= 256 * 1024)
        })
      )
  )

  it.effect(
    'fails closed on corrupt state instead of reusing generation one',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped('acp-process-corrupt-')
          const path = join(root, 'acp-process-state.json')
          yield* Effect.promise(() =>
            writeFile(path, 'not-json', { mode: 0o600 })
          )
          const result = yield* Effect.result(
            makeAcpProcessStateRepository({ path, trustedRoot: root })
          )
          assert.strictEqual(result._tag, 'Failure')
          assert.strictEqual(
            yield* Effect.promise(() => readFile(path, 'utf8')),
            'not-json'
          )
        })
      )
  )

  it.effect('refuses to follow a process-state symlink', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* makeTempDirectoryScoped('acp-process-symlink-')
        const target = join(root, 'target.json')
        const path = join(root, 'acp-process-state.json')
        yield* Effect.promise(() =>
          writeFile(target, JSON.stringify({ nextGeneration: 99 }), {
            mode: 0o600,
          })
        )
        yield* Effect.promise(() => symlink(target, path))

        assert.strictEqual(
          (yield* Effect.result(
            makeAcpProcessStateRepository({ path, trustedRoot: root })
          ))._tag,
          'Failure'
        )
      })
    )
  )
})
