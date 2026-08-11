import { Atom } from '@effect-atom/atom'
import type {
  SharedProjectRow,
  SharedSettingRow,
  SharedStateUpdate,
  SharedTaskRow,
} from '@laborer/shared/rpc'
import { Effect, Stream } from 'effect'

import { LaborerClient } from './laborer-client'

export interface AuthoritativeTable<Row> {
  readonly cursor: number
  readonly rows: readonly Row[]
}

export interface AuthoritativeSharedState {
  readonly projects: AuthoritativeTable<SharedProjectRow>
  readonly settings: AuthoritativeTable<SharedSettingRow>
  readonly tasks: AuthoritativeTable<SharedTaskRow>
}

const initialState: AuthoritativeSharedState = {
  projects: { cursor: 0, rows: [] },
  settings: { cursor: 0, rows: [] },
  tasks: { cursor: 0, rows: [] },
}

type AnyTableUpdate<Row> =
  | {
      readonly cursor: number
      readonly rows: readonly Row[]
      readonly type: 'snapshot'
    }
  | {
      readonly cursor: number
      readonly deletedRowIds: readonly string[]
      readonly mutationIds?: readonly string[] | undefined
      readonly rows: readonly Row[]
      readonly type: 'delta'
    }

const applyTableUpdate = <Row>(
  current: AuthoritativeTable<Row>,
  update: AnyTableUpdate<Row>,
  id: (row: Row) => string
): AuthoritativeTable<Row> => {
  if (
    update.cursor < current.cursor ||
    (update.type === 'delta' && update.cursor === current.cursor)
  ) {
    return current
  }
  if (update.type === 'snapshot') {
    return { cursor: update.cursor, rows: update.rows }
  }
  const rows = new Map(current.rows.map((row) => [id(row), row]))
  for (const deletedId of update.deletedRowIds) {
    rows.delete(deletedId)
  }
  for (const row of update.rows) {
    rows.set(id(row), row)
  }
  return { cursor: update.cursor, rows: [...rows.values()] }
}

export const applySharedStateUpdate = (
  current: AuthoritativeSharedState,
  update: SharedStateUpdate
): AuthoritativeSharedState => ({
  projects:
    update.projects === undefined
      ? current.projects
      : applyTableUpdate(current.projects, update.projects, ({ id }) => id),
  settings:
    update.settings === undefined
      ? current.settings
      : applyTableUpdate(current.settings, update.settings, ({ key }) => key),
  tasks:
    update.tasks === undefined
      ? current.tasks
      : applyTableUpdate(current.tasks, update.tasks, ({ id }) => id),
})

export const authoritativeSharedStateAtom =
  Atom.make<AuthoritativeSharedState>(initialState)

export const installSharedStateUpdateAtom = Atom.writable(
  (get) => get(authoritativeSharedStateAtom),
  (context, update: SharedStateUpdate) =>
    context.set(
      authoritativeSharedStateAtom,
      applySharedStateUpdate(context.get(authoritativeSharedStateAtom), update)
    )
)

export const authoritativeTasksAtom = Atom.make(
  (get) => get(authoritativeSharedStateAtom).tasks
)
export const authoritativeProjectsAtom = Atom.make(
  (get) => get(authoritativeSharedStateAtom).projects
)
export const authoritativeSettingsAtom = Atom.make(
  (get) => get(authoritativeSharedStateAtom).settings
)

export const taskRowsAtom = Atom.make((get) => get(authoritativeTasksAtom).rows)
export const projectRowsAtom = Atom.make(
  (get) => get(authoritativeProjectsAtom).rows
)
/** Legacy renderer shape while workspace surfaces still call the root repoPath. */
export const projectViewsAtom = Atom.make((get) =>
  get(projectRowsAtom).map((project) => ({
    ...project,
    repoPath: project.rootPath,
  }))
)
export const settingRowsAtom = Atom.make(
  (get) => get(authoritativeSettingsAtom).rows
)
export const tasksByIdAtom = Atom.make(
  (get) => new Map(get(taskRowsAtom).map((task) => [task.id, task]))
)
export const projectsByIdAtom = Atom.make(
  (get) => new Map(get(projectRowsAtom).map((project) => [project.id, project]))
)
export const settingsByKeyAtom = Atom.make(
  (get) =>
    new Map(get(settingRowsAtom).map((setting) => [setting.key, setting]))
)

export const makeSharedStateEventsAtom = () =>
  LaborerClient.runtime.pull(
    LaborerClient.pipe(
      Effect.map((client) =>
        // biome-ignore lint/suspicious/noConfusingVoidType: Effect RPC uses void for empty payloads
        client('state.subscribe', undefined as void)
      ),
      Stream.unwrap
    ),
    { disableAccumulation: true }
  )
