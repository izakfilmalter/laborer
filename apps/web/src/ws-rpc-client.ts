import type {
  Project,
  ProjectsAddInput,
  ProjectsCreateThreadInput,
  ProjectsEvent,
  ProjectsSnapshot,
  ProjectThread,
} from '@laborer/contracts/projects'
import { WS_METHODS } from '@laborer/contracts/rpc'
import type {
  ServerConfig,
  ServerConfigStreamEvent,
  ServerLifecycleStreamEvent,
} from '@laborer/contracts/server'

import { WsTransport } from './ws-transport'

export interface WsRpcClient {
  readonly dispose: () => Promise<void>
  readonly projects: {
    readonly add: (input: ProjectsAddInput) => Promise<Project>
    readonly createThread: (
      input: ProjectsCreateThreadInput
    ) => Promise<ProjectThread>
    readonly list: () => Promise<ProjectsSnapshot>
    readonly subscribe: (listener: (event: ProjectsEvent) => void) => () => void
  }
  readonly server: {
    readonly getConfig: () => Promise<ServerConfig>
    readonly subscribeConfig: (
      listener: (event: ServerConfigStreamEvent) => void
    ) => () => void
    readonly subscribeLifecycle: (
      listener: (event: ServerLifecycleStreamEvent) => void
    ) => () => void
  }
}

let sharedWsRpcClient: WsRpcClient | null = null

export function getWsRpcClient(): WsRpcClient {
  if (sharedWsRpcClient) {
    return sharedWsRpcClient
  }

  sharedWsRpcClient = createWsRpcClient()
  return sharedWsRpcClient
}

export async function __resetWsRpcClientForTests() {
  await sharedWsRpcClient?.dispose()
  sharedWsRpcClient = null
}

export function createWsRpcClient(transport = new WsTransport()): WsRpcClient {
  return {
    dispose: () => transport.dispose(),
    projects: {
      add: (input) =>
        transport.request((client) => client[WS_METHODS.projectsAdd](input)),
      createThread: (input) =>
        transport.request((client) =>
          client[WS_METHODS.projectsCreateThread](input)
        ),
      list: () =>
        transport.request((client) => client[WS_METHODS.projectsList]({})),
      subscribe: (listener) =>
        transport.subscribe(
          (client) => client[WS_METHODS.subscribeProjects]({}),
          listener
        ),
    },
    server: {
      getConfig: () =>
        transport.request((client) => client[WS_METHODS.serverGetConfig]({})),
      subscribeConfig: (listener) =>
        transport.subscribe(
          (client) => client[WS_METHODS.subscribeServerConfig]({}),
          listener
        ),
      subscribeLifecycle: (listener) =>
        transport.subscribe(
          (client) => client[WS_METHODS.subscribeServerLifecycle]({}),
          listener
        ),
    },
  }
}
