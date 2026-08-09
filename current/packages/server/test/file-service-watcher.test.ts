/**
 * FileService.watcherSubscribe — Integration Tests
 *
 * Verifies that `FileService.watcherSubscribe()` correctly bridges
 * file watcher events from the FileWatcherClient sidecar to a
 * per-workspace stream with relative file paths.
 *
 * Tests use the `TestFileWatcherClientRecordingWithRecorderLayer` for
 * controlled event injection and subscription verification.
 *
 * @see file-service.ts — FileService implementation
 * @see Issue 5: file.watcher.subscribe — Per-workspace watcher event stream
 */

import { rmSync } from 'node:fs'
import { assert, describe, it } from '@effect/vitest'
import type { FileWatcherEvent } from '@laborer/shared/rpc'
import { events } from '@laborer/shared/schema'
import { Chunk, Effect, Fiber, Layer, Ref, Stream } from 'effect'
import { FileService } from '../src/services/file-service.js'
import { LaborerStore } from '../src/services/laborer-store.js'
import { createTempDir } from './helpers/git-helpers.js'
import {
  TestFileWatcherClientRecorder,
  TestFileWatcherClientRecordingWithRecorderLayer,
} from './helpers/test-file-watcher-client.js'
import { TestLaborerStore } from './helpers/test-store.js'

/**
 * Layer for watcher tests — provides FileService with recording
 * FileWatcherClient mock (+ TestFileWatcherClientRecorder for
 * assertions) and in-memory LaborerStore.
 *
 * Uses `provideMerge` for the recorder layer so
 * `TestFileWatcherClientRecorder` remains in the output context.
 */
const TestWatcherServiceLayer = FileService.layer.pipe(
  Layer.provideMerge(TestFileWatcherClientRecordingWithRecorderLayer),
  Layer.provideMerge(TestLaborerStore)
)

const tempRoots: string[] = []

const cleanupTempRoots = () => {
  for (const root of tempRoots) {
    try {
      rmSync(root, { recursive: true, force: true })
    } catch {
      // Ignore cleanup errors
    }
  }
  tempRoots.length = 0
}

/**
 * Seed a project and running workspace in the test store.
 */
const seedWorkspace = (
  store: LaborerStore['Type']['store'],
  repoPath: string,
  status = 'running'
) => {
  const workspaceId = crypto.randomUUID()
  const projectId = crypto.randomUUID()

  store.commit(
    events.projectCreated({
      id: projectId,
      repoPath,
      name: 'test-project',
    })
  )
  store.commit(
    events.workspaceCreated({
      id: workspaceId,
      projectId,
      taskSource: null,
      branchName: 'main',
      worktreePath: repoPath,
      status,
      origin: 'manual',
      createdAt: new Date().toISOString(),
      baseSha: null,
    })
  )

  return workspaceId
}

/**
 * Helper to collect one event from a watcher stream.
 * Forks the stream, waits for setup, emits an event, and collects.
 */
const collectOneEvent = (
  stream: Stream.Stream<FileWatcherEvent, unknown>,
  recorder: TestFileWatcherClientRecorder['Type'],
  repoPath: string,
  eventOverride?: {
    type?: 'add' | 'change' | 'delete'
    fileName?: string | null
    absolutePath?: string
  }
) =>
  Effect.gen(function* () {
    const fiber = yield* stream.pipe(
      Stream.take(1),
      Stream.runCollect,
      Effect.fork
    )

    yield* Effect.sleep('100 millis')

    const subscriptions = yield* Ref.get(recorder.subscribedPaths)
    const subId = subscriptions[0]?.id ?? ''

    recorder.emitEvent({
      subscriptionId: subId,
      type: eventOverride?.type ?? 'add',
      fileName:
        eventOverride !== undefined && 'fileName' in eventOverride
          ? (eventOverride.fileName ?? null)
          : 'test.ts',
      absolutePath: eventOverride?.absolutePath ?? `${repoPath}/test.ts`,
    })

    return yield* Fiber.join(fiber).pipe(Effect.map(Chunk.toArray))
  })

describe('FileService.watcherSubscribe', () => {
  // --- Behavior 1: Subscribe emits "add" event with correct relative path ---
  it.live('emits add event with relative path when file is created', () =>
    Effect.gen(function* () {
      const repoPath = createTempDir('watcher-add', tempRoots)
      const { store } = yield* LaborerStore
      const workspaceId = seedWorkspace(store, repoPath)
      const recorder = yield* TestFileWatcherClientRecorder
      const fileService = yield* FileService

      const stream = fileService.watcherSubscribe(workspaceId)

      // Verify the watcher is subscribed correctly
      const fiber = yield* stream.pipe(
        Stream.take(1),
        Stream.runCollect,
        Effect.fork
      )
      yield* Effect.sleep('100 millis')

      const subscriptions = yield* Ref.get(recorder.subscribedPaths)
      assert.strictEqual(subscriptions.length, 1)
      assert.strictEqual(subscriptions[0]?.path, repoPath)
      assert.isTrue(subscriptions[0]?.recursive)

      // Emit a synthetic "add" event
      recorder.emitEvent({
        subscriptionId: subscriptions[0]?.id ?? '',
        type: 'add',
        fileName: 'src/new-file.ts',
        absolutePath: `${repoPath}/src/new-file.ts`,
      })

      const collected = yield* Fiber.join(fiber).pipe(Effect.map(Chunk.toArray))

      assert.strictEqual(collected.length, 1)
      const event = collected[0] as FileWatcherEvent
      assert.strictEqual(event.file, 'src/new-file.ts')
      assert.strictEqual(event.event, 'add')

      cleanupTempRoots()
    }).pipe(Effect.scoped, Effect.provide(TestWatcherServiceLayer))
  )

  // --- Behavior 2: "change" event is forwarded ---
  it.live('emits change event when file is modified', () =>
    Effect.gen(function* () {
      const repoPath = createTempDir('watcher-change', tempRoots)
      const { store } = yield* LaborerStore
      const workspaceId = seedWorkspace(store, repoPath)
      const recorder = yield* TestFileWatcherClientRecorder
      const fileService = yield* FileService

      const collected = yield* collectOneEvent(
        fileService.watcherSubscribe(workspaceId),
        recorder,
        repoPath,
        { type: 'change', fileName: 'README.md' }
      )

      assert.strictEqual(collected.length, 1)
      const event = collected[0] as FileWatcherEvent
      assert.strictEqual(event.file, 'README.md')
      assert.strictEqual(event.event, 'change')

      cleanupTempRoots()
    }).pipe(Effect.scoped, Effect.provide(TestWatcherServiceLayer))
  )

  // --- Behavior 3: "delete" maps to "unlink" event ---
  it.live('maps delete event to unlink', () =>
    Effect.gen(function* () {
      const repoPath = createTempDir('watcher-delete', tempRoots)
      const { store } = yield* LaborerStore
      const workspaceId = seedWorkspace(store, repoPath)
      const recorder = yield* TestFileWatcherClientRecorder
      const fileService = yield* FileService

      const collected = yield* collectOneEvent(
        fileService.watcherSubscribe(workspaceId),
        recorder,
        repoPath,
        { type: 'delete', fileName: 'old-file.ts' }
      )

      assert.strictEqual(collected.length, 1)
      const event = collected[0] as FileWatcherEvent
      assert.strictEqual(event.file, 'old-file.ts')
      assert.strictEqual(event.event, 'unlink')

      cleanupTempRoots()
    }).pipe(Effect.scoped, Effect.provide(TestWatcherServiceLayer))
  )

  // --- Behavior 4: Stream teardown unsubscribes the file watcher ---
  it.live('unsubscribes file watcher on stream teardown', () =>
    Effect.gen(function* () {
      const repoPath = createTempDir('watcher-unsub', tempRoots)
      const { store } = yield* LaborerStore
      const workspaceId = seedWorkspace(store, repoPath)
      const recorder = yield* TestFileWatcherClientRecorder
      const fileService = yield* FileService

      // Collect one event (stream completes after take(1))
      yield* collectOneEvent(
        fileService.watcherSubscribe(workspaceId),
        recorder,
        repoPath
      )

      // Give the finalizer a tick to run
      yield* Effect.sleep('50 millis')

      const unsubscribedIds = yield* Ref.get(recorder.unsubscribedIds)
      const subscriptions = yield* Ref.get(recorder.subscribedPaths)
      const subId = subscriptions[0]?.id ?? ''

      assert.isTrue(
        unsubscribedIds.includes(subId),
        'Expected watcher subscription to be unsubscribed after stream teardown'
      )

      assert.strictEqual(
        recorder.handlers.length,
        0,
        'Expected event handlers to be unregistered after stream teardown'
      )

      cleanupTempRoots()
    }).pipe(Effect.scoped, Effect.provide(TestWatcherServiceLayer))
  )

  // --- Behavior 5: Non-existent workspace returns NOT_FOUND ---
  it.live('fails with NOT_FOUND for unknown workspace', () =>
    Effect.gen(function* () {
      const fileService = yield* FileService
      const stream = fileService.watcherSubscribe('nonexistent-workspace-id')

      const result = yield* stream.pipe(
        Stream.runCollect,
        Effect.matchEffect({
          onSuccess: () => Effect.succeed('success' as const),
          onFailure: (error) => Effect.succeed(error),
        })
      )

      if (result === 'success') {
        assert.fail('Expected NOT_FOUND error')
      }
      assert.strictEqual(result._tag, 'RpcError')
      assert.strictEqual(result.code, 'NOT_FOUND')
    }).pipe(Effect.scoped, Effect.provide(TestWatcherServiceLayer))
  )

  // --- Behavior 6: Events from other subscriptions are filtered ---
  it.live('filters events from other subscriptions', () =>
    Effect.gen(function* () {
      const repoPath = createTempDir('watcher-filter', tempRoots)
      const { store } = yield* LaborerStore
      const workspaceId = seedWorkspace(store, repoPath)
      const recorder = yield* TestFileWatcherClientRecorder
      const fileService = yield* FileService

      const stream = fileService.watcherSubscribe(workspaceId)

      const fiber = yield* stream.pipe(
        Stream.take(1),
        Stream.runCollect,
        Effect.fork
      )
      yield* Effect.sleep('100 millis')

      const subscriptions = yield* Ref.get(recorder.subscribedPaths)
      const subId = subscriptions[0]?.id ?? ''

      // Emit from a DIFFERENT subscription — should be ignored
      recorder.emitEvent({
        subscriptionId: 'other-subscription-id',
        type: 'add',
        fileName: 'should-not-appear.ts',
        absolutePath: '/some/other/path/should-not-appear.ts',
      })

      yield* Effect.sleep('50 millis')

      // Emit from OUR subscription — this should be forwarded
      recorder.emitEvent({
        subscriptionId: subId,
        type: 'change',
        fileName: 'our-file.ts',
        absolutePath: `${repoPath}/our-file.ts`,
      })

      const collected = yield* Fiber.join(fiber).pipe(Effect.map(Chunk.toArray))

      assert.strictEqual(collected.length, 1)
      const event = collected[0] as FileWatcherEvent
      assert.strictEqual(event.file, 'our-file.ts')
      assert.strictEqual(event.event, 'change')

      cleanupTempRoots()
    }).pipe(Effect.scoped, Effect.provide(TestWatcherServiceLayer))
  )

  // --- Behavior 7: Destroyed workspace returns INVALID_STATE ---
  it.live('fails with INVALID_STATE for destroyed workspace', () =>
    Effect.gen(function* () {
      const repoPath = createTempDir('watcher-destroyed', tempRoots)
      const { store } = yield* LaborerStore
      const workspaceId = seedWorkspace(store, repoPath, 'destroyed')
      const fileService = yield* FileService

      const stream = fileService.watcherSubscribe(workspaceId)

      const result = yield* stream.pipe(
        Stream.runCollect,
        Effect.matchEffect({
          onSuccess: () => Effect.succeed('success' as const),
          onFailure: (error) => Effect.succeed(error),
        })
      )

      if (result === 'success') {
        assert.fail('Expected INVALID_STATE error')
      }
      assert.strictEqual(result._tag, 'RpcError')
      assert.strictEqual(result.code, 'INVALID_STATE')

      cleanupTempRoots()
    }).pipe(Effect.scoped, Effect.provide(TestWatcherServiceLayer))
  )

  // --- Behavior 8: Falls back to relative path when fileName is null ---
  it.live('uses absolute path fallback when fileName is null', () =>
    Effect.gen(function* () {
      const repoPath = createTempDir('watcher-fallback', tempRoots)
      const { store } = yield* LaborerStore
      const workspaceId = seedWorkspace(store, repoPath)
      const recorder = yield* TestFileWatcherClientRecorder
      const fileService = yield* FileService

      const collected = yield* collectOneEvent(
        fileService.watcherSubscribe(workspaceId),
        recorder,
        repoPath,
        {
          type: 'change',
          fileName: null,
          absolutePath: `${repoPath}/deep/nested/file.ts`,
        }
      )

      assert.strictEqual(collected.length, 1)
      const event = collected[0] as FileWatcherEvent
      assert.strictEqual(event.file, 'deep/nested/file.ts')
      assert.strictEqual(event.event, 'change')

      cleanupTempRoots()
    }).pipe(Effect.scoped, Effect.provide(TestWatcherServiceLayer))
  )
})
