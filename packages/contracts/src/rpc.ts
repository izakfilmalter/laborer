import { Schema } from 'effect'
import { make as makeRpc } from 'effect/unstable/rpc/Rpc'
import { make as makeRpcGroup } from 'effect/unstable/rpc/RpcGroup'

import {
  ProjectsAddInput,
  Project,
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

export const WS_METHODS = {
  projectsList: 'projects.list',
  projectsAdd: 'projects.add',
  projectsCreateThread: 'projects.createThread',
  serverGetConfig: 'server.getConfig',
  subscribeProjects: 'subscribeProjects',
  subscribeServerConfig: 'subscribeServerConfig',
  subscribeServerLifecycle: 'subscribeServerLifecycle',
} as const

const EmptyPayload = Schema.Struct({})

export const WsProjectsListRpc = makeRpc(WS_METHODS.projectsList, {
  payload: EmptyPayload,
  success: ProjectsSnapshot,
})

export const WsProjectsAddRpc = makeRpc(WS_METHODS.projectsAdd, {
  payload: ProjectsAddInput,
  success: Project,
})

export const WsProjectsCreateThreadRpc = makeRpc(
  WS_METHODS.projectsCreateThread,
  {
    payload: ProjectsCreateThreadInput,
    success: ProjectThread,
    error: ProjectsCreateThreadError,
  }
)

export const WsServerGetConfigRpc = makeRpc(WS_METHODS.serverGetConfig, {
  payload: EmptyPayload,
  success: ServerConfig,
})

export const WsSubscribeProjectsRpc = makeRpc(WS_METHODS.subscribeProjects, {
  payload: EmptyPayload,
  success: ProjectsEvent,
  stream: true,
})

export const WsSubscribeServerConfigRpc = makeRpc(
  WS_METHODS.subscribeServerConfig,
  {
    payload: EmptyPayload,
    success: ServerConfigStreamEvent,
    stream: true,
  }
)

export const WsSubscribeServerLifecycleRpc = makeRpc(
  WS_METHODS.subscribeServerLifecycle,
  {
    payload: EmptyPayload,
    success: ServerLifecycleStreamEvent,
    stream: true,
  }
)

export const WsRpcGroup = makeRpcGroup(
  WsProjectsListRpc,
  WsProjectsAddRpc,
  WsProjectsCreateThreadRpc,
  WsServerGetConfigRpc,
  WsSubscribeProjectsRpc,
  WsSubscribeServerConfigRpc,
  WsSubscribeServerLifecycleRpc
)
