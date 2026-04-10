import type { ThreadId } from '@laborer/contracts/base'
import {
  buildProjectsSnapshot,
  projectStoreEvents,
  projectStoreTables,
} from '@laborer/contracts/livestore'
import type {
  Project,
  ProjectsEvent,
  ProjectsSnapshot,
  ProjectThread,
} from '@laborer/contracts/projects'
import { queryDb } from '@livestore/livestore'
import {
  getLoadedProjectsStore,
  useProjectsStore,
} from '@/livestore/projects-store'
import type { WsRpcClient } from '@/ws-rpc-client'
import {
  makeAppStateAtom,
  readAppStateAtom,
  useAppStateValue,
  writeAppStateAtom,
} from './atom-registry'
import { getServerWelcome } from './server-state'

type ProjectsStateClient = Pick<WsRpcClient['projects'], 'subscribe'>

const makeStateAtom = <Value>(label: string, initialValue: Value) =>
  makeAppStateAtom(label, initialValue)

const allProjects$ = queryDb(
  projectStoreTables.projects.select().orderBy('sortOrder', 'asc'),
  {
    label: 'projects.all',
  }
)
const allProjectThreads$ = queryDb(
  projectStoreTables.projectThreads.select().orderBy('sortOrder', 'asc'),
  {
    label: 'project-threads.all',
  }
)

export const activeThreadIdAtom = makeStateAtom<ThreadId | null>(
  'active-thread-id',
  null
)
export const projectsSyncReadyAtom = makeStateAtom<boolean>(
  'projects-sync-ready',
  false
)

export function getProjectsSnapshot(): ProjectsSnapshot | null {
  const store = getLoadedProjectsStore()

  if (store === null) {
    return null
  }

  return buildProjectsSnapshot(
    store.query(
      projectStoreTables.projects.select().orderBy('sortOrder', 'asc')
    ),
    store.query(
      projectStoreTables.projectThreads.select().orderBy('sortOrder', 'asc')
    )
  )
}

export function getActiveThreadId(): ThreadId | null {
  return readAppStateAtom(activeThreadIdAtom)
}

export function getProjectsSyncReady(): boolean {
  return readAppStateAtom(projectsSyncReadyAtom)
}

export function setActiveThreadId(threadId: ThreadId | null): void {
  writeAppStateAtom(activeThreadIdAtom, threadId)
}

export function setProjectsSnapshot(snapshot: ProjectsSnapshot): void {
  const store = getLoadedProjectsStore()

  if (store === null) {
    return
  }

  store.commit(projectStoreEvents.snapshotReplaced({ snapshot }))
  writeAppStateAtom(projectsSyncReadyAtom, true)
  ensureActiveThreadSelection(snapshot)
}

export function applyProjectsEvent(event: ProjectsEvent): void {
  const store = getLoadedProjectsStore()

  if (store === null) {
    return
  }

  switch (event.type) {
    case 'snapshot': {
      setProjectsSnapshot(event.snapshot)
      return
    }
    case 'projectAdded': {
      store.commit(
        projectStoreEvents.projectAdded({
          project: event.payload.project,
          sortOrder: getNextProjectSortOrder(),
        })
      )
      writeAppStateAtom(projectsSyncReadyAtom, true)
      syncActiveThreadSelection()
      return
    }
    case 'threadAdded': {
      store.commit(
        projectStoreEvents.threadAdded({
          projectId: event.payload.projectId,
          thread: event.payload.thread,
          sortOrder: getNextThreadSortOrder(event.payload.projectId),
        })
      )
      writeAppStateAtom(projectsSyncReadyAtom, true)
      syncActiveThreadSelection()
      return
    }
    default: {
      return
    }
  }
}

export function startProjectsStateSync(
  client: ProjectsStateClient
): () => void {
  writeAppStateAtom(projectsSyncReadyAtom, false)

  syncActiveThreadSelection()
  const unsubscribe = client.subscribe((event) => {
    applyProjectsEvent(event)
  })

  return () => {
    unsubscribe()
  }
}

export function useProjectsSnapshot(): ProjectsSnapshot {
  const store = useProjectsStore()
  const projectRows = store.useQuery(allProjects$)
  const threadRows = store.useQuery(allProjectThreads$)

  return buildProjectsSnapshot(projectRows, threadRows)
}

export function useActiveThreadId(): ThreadId | null {
  return useAppStateValue(activeThreadIdAtom)
}

export function useProjectsSyncReady(): boolean {
  return useAppStateValue(projectsSyncReadyAtom)
}

export function useActiveThreadInfo(): {
  readonly project: Project
  readonly thread: ProjectThread
} | null {
  const projectsSnapshot = useProjectsSnapshot()
  const activeThreadId = useActiveThreadId()

  if (!activeThreadId) {
    return null
  }

  return findThreadInfo(projectsSnapshot, activeThreadId)
}

const ensureActiveThreadSelection = (snapshot: ProjectsSnapshot) => {
  const currentActiveThreadId = getActiveThreadId()
  const currentSelection = currentActiveThreadId
    ? findThreadInfo(snapshot, currentActiveThreadId)
    : null

  if (currentSelection !== null) {
    return
  }

  const bootstrapThreadId = getServerWelcome()?.bootstrapThreadId
  if (
    bootstrapThreadId &&
    findThreadInfo(snapshot, bootstrapThreadId) !== null
  ) {
    setActiveThreadId(bootstrapThreadId)
    return
  }

  const firstThread = snapshot.projects[0]?.threads[0]
  setActiveThreadId(firstThread?.id ?? null)
}

const syncActiveThreadSelection = () => {
  const snapshot = getProjectsSnapshot()

  if (snapshot === null) {
    return
  }

  ensureActiveThreadSelection(snapshot)
}

const getNextProjectSortOrder = (): number => {
  const store = getLoadedProjectsStore()

  if (store === null) {
    return 0
  }

  const [firstProject] = store.query(
    projectStoreTables.projects
      .select('sortOrder')
      .orderBy('sortOrder', 'asc')
      .limit(1)
  )

  return firstProject === undefined ? 0 : firstProject - 1
}

const getNextThreadSortOrder = (projectId: Project['id']): number => {
  const store = getLoadedProjectsStore()

  if (store === null) {
    return 0
  }

  const [firstThread] = store.query(
    projectStoreTables.projectThreads
      .select('sortOrder')
      .where({ projectId })
      .orderBy('sortOrder', 'asc')
      .limit(1)
  )

  return firstThread === undefined ? 0 : firstThread - 1
}

const findThreadInfo = (snapshot: ProjectsSnapshot, threadId: ThreadId) => {
  for (const project of snapshot.projects) {
    const thread = project.threads.find(
      (candidate) => candidate.id === threadId
    )
    if (thread) {
      return { project, thread }
    }
  }

  return null
}
