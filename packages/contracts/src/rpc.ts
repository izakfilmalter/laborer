import { Rpc, RpcGroup } from '@effect/rpc'
import { Schema } from 'effect'

import {
  Project,
  ProjectsAddInput,
  ProjectsCreateThreadError,
  ProjectsCreateThreadInput,
  ProjectsEvent,
  ProjectsSnapshot,
  ProjectThread,
} from './projects'
import {
  ServerConfig,
  ServerConfigStreamEvent,
  ServerLifecycleStreamEvent,
} from './server'

interface WsMethods {
  readonly projectsAdd: 'projects.add'
  readonly projectsCreateThread: 'projects.createThread'
  readonly projectsList: 'projects.list'
  readonly serverGetConfig: 'server.getConfig'
  readonly subscribeProjects: 'subscribeProjects'
  readonly subscribeServerConfig: 'subscribeServerConfig'
  readonly subscribeServerLifecycle: 'subscribeServerLifecycle'
}

export const WS_METHODS: WsMethods = {
  projectsList: 'projects.list',
  projectsAdd: 'projects.add',
  projectsCreateThread: 'projects.createThread',
  serverGetConfig: 'server.getConfig',
  subscribeProjects: 'subscribeProjects',
  subscribeServerConfig: 'subscribeServerConfig',
  subscribeServerLifecycle: 'subscribeServerLifecycle',
}

const EmptyPayload = Schema.Struct({})

export const WsProjectsListRpc = Rpc.make(WS_METHODS.projectsList, {
  payload: EmptyPayload,
  success: ProjectsSnapshot,
})

export const WsProjectsAddRpc = Rpc.make(WS_METHODS.projectsAdd, {
  payload: ProjectsAddInput,
  success: Project,
})

export const WsProjectsCreateThreadRpc = Rpc.make(
  WS_METHODS.projectsCreateThread,
  {
    payload: ProjectsCreateThreadInput,
    success: ProjectThread,
    error: ProjectsCreateThreadError,
  }
)

export const WsServerGetConfigRpc = Rpc.make(WS_METHODS.serverGetConfig, {
  payload: EmptyPayload,
  success: ServerConfig,
})

export const WsSubscribeProjectsRpc = Rpc.make(WS_METHODS.subscribeProjects, {
  payload: EmptyPayload,
  success: ProjectsEvent,
  stream: true,
})

export const WsSubscribeServerConfigRpc = Rpc.make(
  WS_METHODS.subscribeServerConfig,
  {
    payload: EmptyPayload,
    success: ServerConfigStreamEvent,
    stream: true,
  }
)

export const WsSubscribeServerLifecycleRpc = Rpc.make(
  WS_METHODS.subscribeServerLifecycle,
  {
    payload: EmptyPayload,
    success: ServerLifecycleStreamEvent,
    stream: true,
  }
)

export const WsRpcGroup = RpcGroup.make(
  WsProjectsListRpc,
  WsProjectsAddRpc,
  WsProjectsCreateThreadRpc,
  WsServerGetConfigRpc,
  WsSubscribeProjectsRpc,
  WsSubscribeServerConfigRpc,
  WsSubscribeServerLifecycleRpc
)
