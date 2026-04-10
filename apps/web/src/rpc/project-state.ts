import type { ThreadId } from '@laborer/contracts/base'
import type {
  Project,
  ProjectsEvent,
  ProjectsSnapshot,
  ProjectThread,
} from '@laborer/contracts/projects'

import type { WsRpcClient } from '@/ws-rpc-client'
import {
  makeAppStateAtom,
  readAppStateAtom,
  useAppStateValue,
  writeAppStateAtom,
} from './atom-registry'
import { getServerWelcome } from './server-state'

type ProjectsStateClient = Pick<WsRpcClient['projects'], 'list' | 'subscribe'>

const makeStateAtom = <Value>(label: string, initialValue: Value) =>
  makeAppStateAtom(label, initialValue)

export const projectsSnapshotAtom = makeStateAtom<ProjectsSnapshot | null>(
  'projects-snapshot',
  null
)
export const activeThreadIdAtom = makeStateAtom<ThreadId | null>(
  'active-thread-id',
  null
)

export function getProjectsSnapshot(): ProjectsSnapshot | null {
  return readAppStateAtom(projectsSnapshotAtom)
}

export function getActiveThreadId(): ThreadId | null {
  return readAppStateAtom(activeThreadIdAtom)
}

export function setActiveThreadId(threadId: ThreadId | null): void {
  writeAppStateAtom(activeThreadIdAtom, threadId)
}

export function setProjectsSnapshot(snapshot: ProjectsSnapshot): void {
  writeAppStateAtom(projectsSnapshotAtom, snapshot)
  ensureActiveThreadSelection(snapshot)
}

export function applyProjectsEvent(event: ProjectsEvent): void {
  switch (event.type) {
    case 'snapshot': {
      setProjectsSnapshot(event.snapshot)
      return
    }
    case 'projectAdded': {
      const current = getProjectsSnapshot()
      if (!current) {
        return
      }

      setProjectsSnapshot({
        projects: [event.payload.project, ...current.projects],
      })
      return
    }
    case 'threadAdded': {
      const current = getProjectsSnapshot()
      if (!current) {
        return
      }

      setProjectsSnapshot({
        projects: current.projects.map((project) =>
          project.id === event.payload.projectId
            ? {
                ...project,
                threads: [event.payload.thread, ...project.threads],
              }
            : project
        ),
      })
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
  let disposed = false
  const unsubscribe = client.subscribe((event) => {
    applyProjectsEvent(event)
  })

  if (getProjectsSnapshot() === null) {
    client
      .list()
      .then((snapshot) => {
        if (disposed || getProjectsSnapshot() !== null) {
          return
        }

        setProjectsSnapshot(snapshot)
      })
      .catch(() => undefined)
  }

  return () => {
    disposed = true
    unsubscribe()
  }
}

export function useProjectsSnapshot(): ProjectsSnapshot | null {
  return useAppStateValue(projectsSnapshotAtom)
}

export function useActiveThreadId(): ThreadId | null {
  return useAppStateValue(activeThreadIdAtom)
}

export function useActiveThreadInfo(): {
  readonly project: Project
  readonly thread: ProjectThread
} | null {
  const projectsSnapshot = useProjectsSnapshot()
  const activeThreadId = useActiveThreadId()

  if (!projectsSnapshot) {
    return null
  }

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
