import type { WorkspaceId } from '@laborer/contracts/base'
import {
  buildProjectsSnapshot,
  projectStoreEvents,
  projectStoreTables,
} from '@laborer/contracts/livestore'
import type {
  Project,
  ProjectsEvent,
  ProjectsSnapshot,
  ProjectWorkspace,
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
const allProjectWorkspaces$ = queryDb(
  projectStoreTables.projectWorkspaces.select().orderBy('sortOrder', 'asc'),
  {
    label: 'project-workspaces.all',
  }
)

export const activeWorkspaceIdAtom = makeStateAtom<WorkspaceId | null>(
  'active-workspace-id',
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
      projectStoreTables.projectWorkspaces.select().orderBy('sortOrder', 'asc')
    )
  )
}

export function getActiveWorkspaceId(): WorkspaceId | null {
  return readAppStateAtom(activeWorkspaceIdAtom)
}

export function getProjectsSyncReady(): boolean {
  return readAppStateAtom(projectsSyncReadyAtom)
}

export function setActiveWorkspaceId(workspaceId: WorkspaceId | null): void {
  writeAppStateAtom(activeWorkspaceIdAtom, workspaceId)
}

export function setProjectsSnapshot(snapshot: ProjectsSnapshot): void {
  const store = getLoadedProjectsStore()

  if (store === null) {
    return
  }

  store.commit(projectStoreEvents.snapshotReplaced({ snapshot }))
  writeAppStateAtom(projectsSyncReadyAtom, true)
  ensureActiveWorkspaceSelection(snapshot)
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
      syncActiveWorkspaceSelection()
      return
    }
    case 'workspaceAdded': {
      store.commit(
        projectStoreEvents.workspaceAdded({
          projectId: event.payload.projectId,
          workspace: event.payload.workspace,
          sortOrder: getNextWorkspaceSortOrder(event.payload.projectId),
        })
      )
      writeAppStateAtom(projectsSyncReadyAtom, true)
      syncActiveWorkspaceSelection()
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

  syncActiveWorkspaceSelection()
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
  const workspaceRows = store.useQuery(allProjectWorkspaces$)

  return buildProjectsSnapshot(projectRows, workspaceRows)
}

export function useActiveWorkspaceId(): WorkspaceId | null {
  return useAppStateValue(activeWorkspaceIdAtom)
}

export function useProjectsSyncReady(): boolean {
  return useAppStateValue(projectsSyncReadyAtom)
}

export function useActiveWorkspaceInfo(): {
  readonly project: Project
  readonly workspace: ProjectWorkspace
} | null {
  const projectsSnapshot = useProjectsSnapshot()
  const activeWorkspaceId = useActiveWorkspaceId()

  if (!activeWorkspaceId) {
    return null
  }

  return findWorkspaceInfo(projectsSnapshot, activeWorkspaceId)
}

const ensureActiveWorkspaceSelection = (snapshot: ProjectsSnapshot) => {
  const currentActiveWorkspaceId = getActiveWorkspaceId()
  const currentSelection = currentActiveWorkspaceId
    ? findWorkspaceInfo(snapshot, currentActiveWorkspaceId)
    : null

  if (currentSelection !== null) {
    return
  }

  const bootstrapWorkspaceId = getServerWelcome()?.bootstrapWorkspaceId
  if (
    bootstrapWorkspaceId &&
    findWorkspaceInfo(snapshot, bootstrapWorkspaceId) !== null
  ) {
    setActiveWorkspaceId(bootstrapWorkspaceId)
    return
  }

  const firstWorkspace = snapshot.projects[0]?.workspaces[0]
  setActiveWorkspaceId(firstWorkspace?.id ?? null)
}

const syncActiveWorkspaceSelection = () => {
  const snapshot = getProjectsSnapshot()

  if (snapshot === null) {
    return
  }

  ensureActiveWorkspaceSelection(snapshot)
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

const getNextWorkspaceSortOrder = (projectId: Project['id']): number => {
  const store = getLoadedProjectsStore()

  if (store === null) {
    return 0
  }

  const [firstWorkspace] = store.query(
    projectStoreTables.projectWorkspaces
      .select('sortOrder')
      .where({ projectId })
      .orderBy('sortOrder', 'asc')
      .limit(1)
  )

  return firstWorkspace === undefined ? 0 : firstWorkspace - 1
}

const findWorkspaceInfo = (
  snapshot: ProjectsSnapshot,
  workspaceId: WorkspaceId
) => {
  for (const project of snapshot.projects) {
    const workspace = project.workspaces.find(
      (candidate) => candidate.id === workspaceId
    )
    if (workspace) {
      return { project, workspace }
    }
  }

  return null
}
