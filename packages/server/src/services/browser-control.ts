import { randomUUID } from 'node:crypto'
import type {
  BrowserControlEvent,
  BrowserControlHost,
  BrowserControlOperation,
  BrowserControlResponse,
} from '@laborer/shared/browser-control'
import { BrowserControlError } from '@laborer/shared/browser-control'
import {
  Context,
  Deferred,
  Effect,
  Layer,
  Option,
  Queue,
  Stream,
  SynchronizedRef,
} from 'effect'

interface Host {
  readonly clientId: string
  readonly connectionId: string
  readonly events: Queue.Queue<BrowserControlEvent>
  readonly workspaceId: string
}

interface Pending {
  readonly controllerId: string
  readonly deferred: Deferred.Deferred<unknown, BrowserControlError>
  readonly host: Host
}

interface State {
  readonly hosts: ReadonlyMap<string, Host>
  readonly owners: ReadonlyMap<string, string>
  readonly pending: ReadonlyMap<string, Pending>
  readonly sequence: number
}

export class BrowserControl extends Context.Service<
  BrowserControl,
  {
    readonly connect: (
      input: BrowserControlHost
    ) => Effect.Effect<Stream.Stream<BrowserControlEvent>>
    readonly respond: (
      response: BrowserControlResponse
    ) => Effect.Effect<void, BrowserControlError>
    readonly invoke: (input: {
      readonly workspaceId: string
      readonly controllerId: string
      readonly tabId?: string
      readonly operation: BrowserControlOperation
      readonly input: unknown
      readonly timeoutMs?: number
    }) => Effect.Effect<unknown, BrowserControlError>
    readonly cancel: (
      workspaceId: string,
      controllerId: string
    ) => Effect.Effect<void>
  }
>()('@laborer/server/BrowserControl') {
  static readonly layer = Layer.effect(
    BrowserControl,
    Effect.gen(function* () {
      const state = yield* SynchronizedRef.make<State>({
        hosts: new Map(),
        owners: new Map(),
        pending: new Map(),
        sequence: 0,
      })

      const disconnect: (host: Host) => Effect.Effect<void> = Effect.fn(
        'BrowserControl.disconnect'
      )(function* (host: Host) {
        const removed = yield* SynchronizedRef.modify(state, (current) => {
          const hosts = new Map(current.hosts)
          const owners = new Map(current.owners)
          const pending = new Map(current.pending)
          if (hosts.get(host.workspaceId) === host) {
            hosts.delete(host.workspaceId)
          }
          const interrupted: Pending[] = []
          for (const [id, value] of pending) {
            if (value.host !== host) {
              continue
            }
            pending.delete(id)
            interrupted.push(value)
          }
          if (
            ![...pending.values()].some(
              (entry) => entry.host.workspaceId === host.workspaceId
            )
          ) {
            owners.delete(host.workspaceId)
          }
          return [
            interrupted,
            { ...current, hosts, owners, pending },
          ] as readonly [readonly Pending[], State]
        })
        yield* Effect.forEach(
          removed,
          ({ deferred }) =>
            Deferred.fail(
              deferred,
              new BrowserControlError({
                code: 'DISCONNECTED',
                message: 'Browser host disconnected',
              })
            ),
          { discard: true }
        )
        yield* Queue.shutdown(host.events)
      })

      const connect = Effect.fn('BrowserControl.connect')(function* (
        input: BrowserControlHost
      ) {
        const events = yield* Queue.unbounded<BrowserControlEvent>()
        const host: Host = { ...input, connectionId: randomUUID(), events }
        const previous = yield* SynchronizedRef.modify(state, (current) => {
          const hosts = new Map(current.hosts)
          const old = hosts.get(input.workspaceId)
          hosts.set(input.workspaceId, host)
          return [old, { ...current, hosts }] as const
        })
        if (previous) {
          yield* disconnect(previous)
        }
        yield* Queue.offer(events, {
          type: 'connected',
          connectionId: host.connectionId,
        })
        return Stream.fromQueue(events).pipe(Stream.ensuring(disconnect(host)))
      })

      const respond = Effect.fn('BrowserControl.respond')(function* (
        response: BrowserControlResponse
      ) {
        const entry = yield* SynchronizedRef.modify(state, (current) => {
          const value = current.pending.get(response.requestId)
          if (
            !value ||
            value.host.clientId !== response.clientId ||
            value.host.connectionId !== response.connectionId
          ) {
            return [undefined, current] as const
          }
          const pending = new Map(current.pending)
          pending.delete(response.requestId)
          const owners = new Map(current.owners)
          if (
            ![...pending.values()].some(
              (entry) => entry.host.workspaceId === value.host.workspaceId
            )
          ) {
            owners.delete(value.host.workspaceId)
          }
          return [value, { ...current, owners, pending }] as const
        })
        if (!entry) {
          return
        }
        if (response.status === 'result') {
          yield* Deferred.succeed(entry.deferred, response.result)
        } else {
          yield* Deferred.fail(
            entry.deferred,
            new BrowserControlError({
              code: response.status === 'cancelled' ? 'CANCELLED' : 'FAILED',
              message:
                response.error?.message ?? `Browser request ${response.status}`,
            })
          )
        }
      })

      const cancel = Effect.fn('BrowserControl.cancel')(function* (
        workspaceId: string,
        controllerId: string
      ) {
        const cancelled = yield* SynchronizedRef.modify(state, (current) => {
          if (current.owners.get(workspaceId) !== controllerId) {
            return [[], current] as readonly [readonly Pending[], State]
          }
          const owners = new Map(current.owners)
          const pending = new Map(current.pending)
          owners.delete(workspaceId)
          const values: Pending[] = []
          for (const [id, value] of pending) {
            if (
              value.controllerId !== controllerId ||
              value.host.workspaceId !== workspaceId
            ) {
              continue
            }
            pending.delete(id)
            values.push(value)
          }
          return [values, { ...current, owners, pending }] as readonly [
            readonly Pending[],
            State,
          ]
        })
        yield* Effect.forEach(
          cancelled,
          ({ deferred }) =>
            Deferred.fail(
              deferred,
              new BrowserControlError({
                code: 'CANCELLED',
                message: 'Browser control was cancelled',
              })
            ),
          { discard: true }
        )
      })

      const invoke = Effect.fn('BrowserControl.invoke')(function* (input: {
        readonly workspaceId: string
        readonly controllerId: string
        readonly tabId?: string
        readonly operation: BrowserControlOperation
        readonly input: unknown
        readonly timeoutMs?: number
      }) {
        const deferred = yield* Deferred.make<unknown, BrowserControlError>()
        const timeoutMs = Math.min(
          60_000,
          Math.max(1, input.timeoutMs ?? 15_000)
        )
        type Route =
          | { readonly conflict: true }
          | {
              readonly conflict: false
              readonly host: Host
              readonly requestId: string
            }
          | undefined
        const route = yield* SynchronizedRef.modify(state, (current) => {
          const host = current.hosts.get(input.workspaceId)
          if (!host) {
            return [undefined, current] as readonly [Route, State]
          }
          const owner = current.owners.get(input.workspaceId)
          if (owner !== undefined && owner !== input.controllerId) {
            return [{ conflict: true as const }, current] as readonly [
              Route,
              State,
            ]
          }
          const requestId = `browser-${String(current.sequence)}`
          const owners = new Map(current.owners)
          const pending = new Map(current.pending)
          owners.set(input.workspaceId, input.controllerId)
          pending.set(requestId, {
            host,
            controllerId: input.controllerId,
            deferred,
          })
          return [
            { conflict: false as const, host, requestId },
            { ...current, owners, pending, sequence: current.sequence + 1 },
          ] as readonly [Route, State]
        })
        if (!route) {
          return yield* new BrowserControlError({
            code: 'NO_HOST',
            message: `No browser host is connected for workspace ${input.workspaceId}`,
          })
        }
        if (route.conflict) {
          return yield* new BrowserControlError({
            code: 'NOT_OWNER',
            message: 'Another agent controls this workspace browser',
          })
        }
        const removePending = SynchronizedRef.update(state, (current) => {
          const pending = new Map(current.pending)
          pending.delete(route.requestId)
          const owners = new Map(current.owners)
          if (
            ![...pending.values()].some(
              (entry) => entry.host.workspaceId === input.workspaceId
            )
          ) {
            owners.delete(input.workspaceId)
          }
          return { ...current, owners, pending }
        })
        yield* Queue.offer(route.host.events, {
          type: 'request',
          connectionId: route.host.connectionId,
          request: {
            requestId: route.requestId,
            controllerId: input.controllerId,
            workspaceId: input.workspaceId,
            ...(input.tabId === undefined ? {} : { tabId: input.tabId }),
            operation: input.operation,
            input: input.input,
            timeoutMs,
          },
        })
        const result = yield* Deferred.await(deferred).pipe(
          Effect.timeoutOption(timeoutMs),
          Effect.ensuring(removePending)
        )
        return yield* Option.match(result, {
          onNone: () =>
            Effect.fail(
              new BrowserControlError({
                code: 'TIMEOUT',
                message: `Browser ${input.operation} timed out after ${String(timeoutMs)}ms`,
              })
            ),
          onSome: Effect.succeed,
        })
      })

      return BrowserControl.of({ connect, respond, invoke, cancel })
    })
  )
}
