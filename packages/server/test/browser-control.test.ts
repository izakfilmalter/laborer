import { describe, expect, it } from '@effect/vitest'
import { Effect, Fiber, Queue, Stream } from 'effect'
import { TestClock } from 'effect/testing'
import { BrowserControl } from '../src/services/browser-control.js'

describe('BrowserControl', () => {
  it.effect('correlates responses and rejects concurrent ownership', () =>
    Effect.gen(function* () {
      const control = yield* BrowserControl
      const events = yield* Queue.unbounded<any>()
      const stream = yield* control.connect({
        clientId: 'renderer-1',
        workspaceId: 'workspace-1',
      })
      yield* Stream.runForEach(stream, (event) =>
        Queue.offer(events, event)
      ).pipe(Effect.forkChild)
      const connected = yield* Queue.take(events)
      expect(connected.type).toBe('connected')

      const first = yield* control
        .invoke({
          workspaceId: 'workspace-1',
          controllerId: 'agent-1',
          operation: 'snapshot',
          input: {},
        })
        .pipe(Effect.forkChild)
      const request = yield* Queue.take(events)
      expect(request.request.operation).toBe('snapshot')

      const conflict = yield* Effect.flip(
        control.invoke({
          workspaceId: 'workspace-1',
          controllerId: 'agent-2',
          operation: 'status',
          input: {},
        })
      )
      expect(conflict.code).toBe('NOT_OWNER')
      yield* control.respond({
        clientId: 'renderer-1',
        connectionId: connected.connectionId,
        requestId: request.request.requestId,
        status: 'result',
        result: { title: 'Laborer' },
      })
      expect(yield* Fiber.join(first)).toEqual({ title: 'Laborer' })
    }).pipe(Effect.provide(BrowserControl.layer))
  )

  it.effect('times out and ignores a late response', () =>
    Effect.gen(function* () {
      const control = yield* BrowserControl
      const events = yield* Queue.unbounded<any>()
      const stream = yield* control.connect({
        clientId: 'renderer-1',
        workspaceId: 'workspace-1',
      })
      yield* Stream.runForEach(stream, (event) =>
        Queue.offer(events, event)
      ).pipe(Effect.forkChild)
      const connected = yield* Queue.take(events)
      const fiber = yield* control
        .invoke({
          workspaceId: 'workspace-1',
          controllerId: 'agent-1',
          operation: 'waitFor',
          input: {},
          timeoutMs: 100,
        })
        .pipe(Effect.flip, Effect.forkChild)
      const event = yield* Queue.take(events)
      yield* TestClock.adjust('100 millis')
      expect((yield* Fiber.join(fiber)).code).toBe('TIMEOUT')
      yield* control.respond({
        clientId: 'renderer-1',
        connectionId: connected.connectionId,
        requestId: event.request.requestId,
        status: 'result',
        result: 'late',
      })
    }).pipe(Effect.provide(BrowserControl.layer))
  )

  it.effect('fails pending work when the host disconnects', () =>
    Effect.gen(function* () {
      const control = yield* BrowserControl
      const events = yield* Queue.unbounded<any>()
      const stream = yield* control.connect({
        clientId: 'renderer-1',
        workspaceId: 'workspace-1',
      })
      const host = yield* Stream.runForEach(stream, (event) =>
        Queue.offer(events, event)
      ).pipe(Effect.forkChild)
      yield* Queue.take(events)
      const request = yield* control
        .invoke({
          workspaceId: 'workspace-1',
          controllerId: 'agent-1',
          operation: 'click',
          input: {},
        })
        .pipe(Effect.flip, Effect.forkChild)
      yield* Queue.take(events)
      yield* Fiber.interrupt(host)
      expect((yield* Fiber.join(request)).code).toBe('DISCONNECTED')
    }).pipe(Effect.provide(BrowserControl.layer))
  )

  it.effect('buffers early requests and disconnects replaced hosts', () =>
    Effect.gen(function* () {
      const control = yield* BrowserControl
      const firstEvents = yield* Queue.unbounded<any>()
      const firstStream = yield* control.connect({
        clientId: 'renderer-1',
        workspaceId: 'workspace-1',
      })
      yield* Stream.runForEach(firstStream, (event) =>
        Queue.offer(firstEvents, event)
      ).pipe(Effect.forkChild)
      yield* Queue.take(firstEvents)
      const abandoned = yield* control
        .invoke({
          workspaceId: 'workspace-1',
          controllerId: 'agent-1',
          operation: 'click',
          input: {},
        })
        .pipe(Effect.flip, Effect.forkChild)
      yield* Queue.take(firstEvents)

      const secondStream = yield* control.connect({
        clientId: 'renderer-2',
        workspaceId: 'workspace-1',
      })
      expect((yield* Fiber.join(abandoned)).code).toBe('DISCONNECTED')
      const buffered = yield* control
        .invoke({
          workspaceId: 'workspace-1',
          controllerId: 'agent-2',
          operation: 'snapshot',
          input: {},
        })
        .pipe(Effect.forkChild)
      yield* Effect.yieldNow

      const secondEvents = yield* Queue.unbounded<any>()
      yield* Stream.runForEach(secondStream, (event) =>
        Queue.offer(secondEvents, event)
      ).pipe(Effect.forkChild)
      const connected = yield* Queue.take(secondEvents)
      const request = yield* Queue.take(secondEvents)
      expect(request.request.operation).toBe('snapshot')
      yield* control.respond({
        clientId: 'renderer-2',
        connectionId: connected.connectionId,
        requestId: request.request.requestId,
        status: 'result',
        result: 'ready',
      })
      expect(yield* Fiber.join(buffered)).toBe('ready')
    }).pipe(Effect.provide(BrowserControl.layer))
  )
})
