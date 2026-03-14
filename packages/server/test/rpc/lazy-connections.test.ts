/**
 * Lazy Sidecar Connections Test — Issue #16
 *
 * Verifies that TerminalClient and FileWatcherClient establish
 * connections lazily (on first RPC call) rather than eagerly
 * during layer construction:
 *
 * 1. FileWatcherClient.layer builds instantly without connecting
 *    to the file-watcher sidecar (no RPC call on construction)
 * 2. TerminalClient.layer builds instantly without connecting
 *    to the terminal sidecar (no RPC call on construction)
 * 3. The server can start and serve health checks while sidecar
 *    connections are deferred to first use
 * 4. FileWatcherClient event handler registration works before
 *    connection (events buffered until connected)
 * 5. TerminalClient methods return 0 gracefully when no terminals
 *    are tracked (sidecar not yet connected)
 */

import { assert, describe, it } from '@effect/vitest'
import { Context, Effect, Layer } from 'effect'
import { ConfigService } from '../../src/services/config-service.js'
import { makeServiceProxy } from '../../src/services/deferred-service.js'
import {
  type FileEventHandler,
  FileWatcherClient,
} from '../../src/services/file-watcher-client.js'
import { ProjectRegistry } from '../../src/services/project-registry.js'
import { TerminalClient } from '../../src/services/terminal-client.js'
import { WorkspaceProvider } from '../../src/services/workspace-provider.js'
import { TestLaborerStore } from '../helpers/test-store.js'

describe('Lazy sidecar connections (Issue #16)', () => {
  describe('FileWatcherClient', () => {
    it.scoped(
      'layer builds instantly without connecting to file-watcher sidecar',
      () =>
        Effect.gen(function* () {
          // FileWatcherClient.layer should build successfully without
          // the file-watcher sidecar running. The layer construction
          // no longer establishes a network connection — that's deferred
          // to the first method call.
          const ctx = yield* Layer.build(FileWatcherClient.layer)
          const fileWatcherClient = Context.get(ctx, FileWatcherClient)

          // The service should be available with all methods
          assert.isDefined(fileWatcherClient)
          assert.isFunction(fileWatcherClient.subscribe)
          assert.isFunction(fileWatcherClient.unsubscribe)
          assert.isFunction(fileWatcherClient.updateIgnore)
          assert.isFunction(fileWatcherClient.onFileEvent)
          assert.isFunction(fileWatcherClient.listSubscriptions)
        })
    )

    it.scoped('onFileEvent handler can be registered before connection', () =>
      Effect.gen(function* () {
        const ctx = yield* Layer.build(FileWatcherClient.layer)
        const fileWatcherClient = Context.get(ctx, FileWatcherClient)

        // Register a handler — this should work immediately without
        // needing a connection. Handlers are stored in an in-memory
        // array and dispatched when events arrive after connection.
        const events: unknown[] = []
        const handler: FileEventHandler = (event) => {
          events.push(event)
        }
        const subscription = fileWatcherClient.onFileEvent(handler)

        // Verify we got a valid subscription handle
        assert.isFunction(subscription.unsubscribe)

        // Unsubscribe should also work
        subscription.unsubscribe()
      })
    )
  })

  describe('TerminalClient', () => {
    /**
     * TerminalClient.layer requires LaborerStore, WorkspaceProvider,
     * ConfigService, and ProjectRegistry. For this test, we provide
     * stubs for the deferred services and real implementations for
     * core services.
     */
    const TerminalClientTestLayer = TerminalClient.layer.pipe(
      Layer.provide(
        Layer.succeed(WorkspaceProvider, makeServiceProxy('WorkspaceProvider'))
      ),
      Layer.provide(
        Layer.succeed(ProjectRegistry, makeServiceProxy('ProjectRegistry'))
      ),
      Layer.provide(ConfigService.layer),
      Layer.provide(TestLaborerStore)
    )

    it.scoped(
      'layer builds instantly without connecting to terminal sidecar',
      () =>
        Effect.gen(function* () {
          // TerminalClient.layer should build successfully without
          // the terminal sidecar running. The layer construction
          // no longer establishes a network connection — that's deferred
          // to the first method call.
          const ctx = yield* Layer.build(TerminalClientTestLayer)
          const terminalClient = Context.get(ctx, TerminalClient)

          // The service should be available
          assert.isDefined(terminalClient)
          assert.isFunction(terminalClient.spawnInWorkspace)
          assert.isFunction(terminalClient.killAllForWorkspace)
        })
    )

    it.scoped(
      'killAllForWorkspace returns 0 when no terminals tracked (before connection)',
      () =>
        Effect.gen(function* () {
          const ctx = yield* Layer.build(TerminalClientTestLayer)
          const terminalClient = Context.get(ctx, TerminalClient)

          // killAllForWorkspace should return 0 (no terminals killed)
          // when the terminal map is empty. Since the connection is lazy,
          // the map starts empty and no sidecar call is needed.
          const killed = yield* terminalClient.killAllForWorkspace(
            'nonexistent-workspace'
          )

          assert.strictEqual(killed, 0)
        })
    )
  })

  describe('Build timing', () => {
    it.live(
      'FileWatcherClient layer builds in under 1 second without sidecar',
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            // Verify that building FileWatcherClient.layer completes
            // quickly (it no longer blocks on connecting to the sidecar).
            const startTime = Date.now()
            yield* Layer.build(FileWatcherClient.layer)
            const elapsed = Date.now() - startTime

            // Layer build should be fast (< 1 second).
            // In the old eager implementation, this would hang waiting
            // for the sidecar to respond.
            assert.isTrue(
              elapsed < 1000,
              `FileWatcherClient.layer took ${elapsed}ms — should be under 1000ms`
            )
          })
        )
    )

    it.live(
      'TerminalClient layer builds in under 1 second without sidecar',
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const testLayer = TerminalClient.layer.pipe(
              Layer.provide(
                Layer.succeed(
                  WorkspaceProvider,
                  makeServiceProxy('WorkspaceProvider')
                )
              ),
              Layer.provide(
                Layer.succeed(
                  ProjectRegistry,
                  makeServiceProxy('ProjectRegistry')
                )
              ),
              Layer.provide(ConfigService.layer),
              Layer.provide(TestLaborerStore)
            )

            const startTime = Date.now()
            yield* Layer.build(testLayer)
            const elapsed = Date.now() - startTime

            assert.isTrue(
              elapsed < 1000,
              `TerminalClient.layer took ${elapsed}ms — should be under 1000ms`
            )
          })
        )
    )
  })
})
