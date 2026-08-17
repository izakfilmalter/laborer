/**
 * PROTOTYPE — throw away after issue #548 is decided.
 *
 * Question: can one Effect-owned RPC stream safely populate four stable
 * TanStack DB collections while retaining Laborer's per-table cursor,
 * snapshot-replacement, boundary-decoding, and cleanup semantics?
 */

import {
  type SharedLabelRow,
  type SharedProjectRow,
  type SharedSettingRow,
  SharedStateUpdate,
  type SharedTaskRow,
} from '@laborer/shared/rpc'
import { createCollection, type SyncConfig } from '@tanstack/db'
import { Effect, Fiber, Schema, Stream } from 'effect'

type TableName = 'labels' | 'projects' | 'settings' | 'tasks'
type TableUpdate<Row> =
  | {
      readonly cursor: number
      readonly rows: readonly Row[]
      readonly type: 'snapshot'
    }
  | {
      readonly cursor: number
      readonly deletedRowIds: readonly string[]
      readonly rows: readonly Row[]
      readonly type: 'delta'
    }

type SyncControls<Row extends object> = Parameters<
  SyncConfig<Row, string>['sync']
>[0]

interface RegisteredTable {
  readonly apply: (update: TableUpdate<never>) => void
}

class SharedStateSyncCoordinator {
  readonly cursors: Record<TableName, number> = {
    labels: 0,
    projects: 0,
    settings: 0,
    tasks: 0,
  }
  readonly commits: TableName[] = []
  readonly rejections: string[] = []
  observeCommit: ((name: TableName) => void) | undefined
  subscriptionStarts = 0
  subscriptionStops = 0

  private readonly source: () => Stream.Stream<unknown, unknown>
  private readonly tables = new Map<TableName, RegisteredTable>()
  private fiber: Fiber.Fiber<void, unknown> | undefined

  constructor(source: () => Stream.Stream<unknown, unknown>) {
    this.source = source
  }

  register<Row extends object>(
    name: TableName,
    controls: SyncControls<Row>
  ): () => void {
    let cursor = 0
    let ready = false

    const apply = (update: TableUpdate<Row>) => {
      if (update.type === 'delta' && update.cursor <= cursor) {
        this.rejections.push(
          `${name}:${String(update.cursor)}<=${String(cursor)}`
        )
        return
      }

      controls.begin()
      if (update.type === 'snapshot') {
        controls.truncate()
        for (const row of update.rows) {
          controls.write({ type: 'insert', value: row })
        }
      } else {
        for (const key of update.deletedRowIds) {
          controls.write({ key, type: 'delete' })
        }
        for (const row of update.rows) {
          controls.write({ type: 'update', value: row })
        }
      }
      controls.commit()
      cursor = update.cursor
      this.cursors[name] = cursor
      this.commits.push(name)
      this.observeCommit?.(name)
      if (!ready) {
        ready = true
        controls.markReady()
      }
    }

    this.tables.set(name, { apply: apply as RegisteredTable['apply'] })
    if (this.tables.size === 4) {
      this.start()
    }

    return () => {
      this.tables.delete(name)
      // Each TanStack sync cleanup releases only the registration it acquired.
      // The multiplexed source is shared and closes only after its last sink.
      if (this.tables.size === 0) {
        this.stop()
      }
    }
  }

  private start(): void {
    if (this.fiber !== undefined) {
      return
    }
    this.subscriptionStarts += 1
    const consume = this.source().pipe(
      Stream.mapEffect((input) =>
        Schema.decodeUnknownEffect(SharedStateUpdate)(input)
      ),
      Stream.runForEach((update) =>
        Effect.sync(() => {
          this.apply('labels', update.labels)
          this.apply('projects', update.projects)
          this.apply('settings', update.settings)
          this.apply('tasks', update.tasks)
        })
      ),
      Effect.ensuring(
        Effect.sync(() => {
          this.subscriptionStops += 1
        })
      )
    )
    this.fiber = Effect.runFork(consume)
  }

  private apply<Row>(name: TableName, update: TableUpdate<Row> | undefined) {
    if (update !== undefined) {
      this.tables.get(name)?.apply(update as TableUpdate<never>)
    }
  }

  private stop(): void {
    if (this.fiber === undefined) {
      return
    }
    Effect.runFork(Fiber.interrupt(this.fiber))
    this.fiber = undefined
  }
}

const collectionOptions = <Row extends object>(
  id: string,
  name: TableName,
  coordinator: SharedStateSyncCoordinator,
  keyOf: (row: Row) => string
) => ({
  getKey: keyOf,
  id,
  startSync: false,
  sync: {
    rowUpdateMode: 'full' as const,
    sync: (controls: SyncControls<Row>) => coordinator.register(name, controls),
  },
})

export const makePrototypeCollections = (
  source: () => Stream.Stream<unknown, unknown>
) => {
  const coordinator = new SharedStateSyncCoordinator(source)
  const labels = createCollection(
    collectionOptions<SharedLabelRow>(
      'prototype-labels',
      'labels',
      coordinator,
      (row) => row.id
    )
  )
  const projects = createCollection(
    collectionOptions<SharedProjectRow>(
      'prototype-projects',
      'projects',
      coordinator,
      (row) => row.id
    )
  )
  const settings = createCollection(
    collectionOptions<SharedSettingRow>(
      'prototype-settings',
      'settings',
      coordinator,
      (row) => row.key
    )
  )
  const tasks = createCollection(
    collectionOptions<SharedTaskRow>(
      'prototype-tasks',
      'tasks',
      coordinator,
      (row) => row.id
    )
  )

  const preload = () =>
    Promise.all([
      labels.preload(),
      projects.preload(),
      settings.preload(),
      tasks.preload(),
    ])

  const cleanup = () =>
    Promise.all([
      labels.cleanup(),
      projects.cleanup(),
      settings.cleanup(),
      tasks.cleanup(),
    ])

  return { cleanup, coordinator, labels, preload, projects, settings, tasks }
}
