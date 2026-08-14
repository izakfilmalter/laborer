import { Atom } from 'effect/unstable/reactivity'

import { LaborerClient } from './laborer-client'

/** One durable watcher atom per workspace; runtime generation re-subscribes it. */
export const fileWatcherEventsAtom = Atom.family((workspaceId: string) =>
  LaborerClient.query('file.watcher.subscribe', { workspaceId })
)
