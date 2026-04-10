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
import { ShellOpenInEditorError, ShellOpenInEditorInput } from './shell'
import {
  TerminalClearInput,
  TerminalCloseInput,
  TerminalError,
  TerminalEvent,
  TerminalOpenInput,
  TerminalResizeInput,
  TerminalRestartInput,
  TerminalSessionSnapshot,
  TerminalWriteInput,
} from './terminal'

interface WsMethods {
  readonly projectsAdd: 'projects.add'
  readonly projectsCreateThread: 'projects.createThread'
  readonly projectsList: 'projects.list'
  readonly serverGetConfig: 'server.getConfig'
  readonly shellOpenInEditor: 'shell.openInEditor'
  readonly subscribeProjects: 'subscribeProjects'
  readonly subscribeServerConfig: 'subscribeServerConfig'
  readonly subscribeServerLifecycle: 'subscribeServerLifecycle'
  readonly subscribeTerminalEvents: 'subscribeTerminalEvents'
  readonly terminalClear: 'terminal.clear'
  readonly terminalClose: 'terminal.close'
  readonly terminalOpen: 'terminal.open'
  readonly terminalResize: 'terminal.resize'
  readonly terminalRestart: 'terminal.restart'
  readonly terminalWrite: 'terminal.write'
}

export const WS_METHODS: WsMethods = {
  projectsList: 'projects.list',
  projectsAdd: 'projects.add',
  projectsCreateThread: 'projects.createThread',
  shellOpenInEditor: 'shell.openInEditor',
  serverGetConfig: 'server.getConfig',
  subscribeProjects: 'subscribeProjects',
  subscribeServerConfig: 'subscribeServerConfig',
  subscribeServerLifecycle: 'subscribeServerLifecycle',
  subscribeTerminalEvents: 'subscribeTerminalEvents',
  terminalClear: 'terminal.clear',
  terminalClose: 'terminal.close',
  terminalOpen: 'terminal.open',
  terminalResize: 'terminal.resize',
  terminalRestart: 'terminal.restart',
  terminalWrite: 'terminal.write',
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

export const WsShellOpenInEditorRpc = Rpc.make(WS_METHODS.shellOpenInEditor, {
  payload: ShellOpenInEditorInput,
  success: EmptyPayload,
  error: ShellOpenInEditorError,
})

export const WsServerGetConfigRpc = Rpc.make(WS_METHODS.serverGetConfig, {
  payload: EmptyPayload,
  success: ServerConfig,
})

export const WsTerminalOpenRpc = Rpc.make(WS_METHODS.terminalOpen, {
  payload: TerminalOpenInput,
  success: TerminalSessionSnapshot,
  error: TerminalError,
})

export const WsTerminalWriteRpc = Rpc.make(WS_METHODS.terminalWrite, {
  payload: TerminalWriteInput,
  success: EmptyPayload,
  error: TerminalError,
})

export const WsTerminalResizeRpc = Rpc.make(WS_METHODS.terminalResize, {
  payload: TerminalResizeInput,
  success: EmptyPayload,
  error: TerminalError,
})

export const WsTerminalClearRpc = Rpc.make(WS_METHODS.terminalClear, {
  payload: TerminalClearInput,
  success: EmptyPayload,
  error: TerminalError,
})

export const WsTerminalRestartRpc = Rpc.make(WS_METHODS.terminalRestart, {
  payload: TerminalRestartInput,
  success: TerminalSessionSnapshot,
  error: TerminalError,
})

export const WsTerminalCloseRpc = Rpc.make(WS_METHODS.terminalClose, {
  payload: TerminalCloseInput,
  success: EmptyPayload,
  error: TerminalError,
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

export const WsSubscribeTerminalEventsRpc = Rpc.make(
  WS_METHODS.subscribeTerminalEvents,
  {
    payload: EmptyPayload,
    success: TerminalEvent,
    stream: true,
  }
)

export const WsRpcGroup = RpcGroup.make(
  WsProjectsListRpc,
  WsProjectsAddRpc,
  WsProjectsCreateThreadRpc,
  WsShellOpenInEditorRpc,
  WsServerGetConfigRpc,
  WsTerminalOpenRpc,
  WsTerminalWriteRpc,
  WsTerminalResizeRpc,
  WsTerminalClearRpc,
  WsTerminalRestartRpc,
  WsTerminalCloseRpc,
  WsSubscribeProjectsRpc,
  WsSubscribeServerConfigRpc,
  WsSubscribeServerLifecycleRpc,
  WsSubscribeTerminalEventsRpc
)
