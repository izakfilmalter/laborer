import type {
  Project,
  ProjectsAddInput,
  ProjectsCreateThreadInput,
  ProjectsEvent,
  ProjectsSnapshot,
  ProjectThread,
} from '@laborer/contracts/projects'
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
      add: (input) => transport.request((client) => client.projects.add(input)),
      createThread: (input) =>
        transport.request((client) => client.projects.createThread(input)),
      list: () => transport.request((client) => client.projects.list({})),
      subscribe: (listener) =>
        transport.subscribe(
          (client) =>
            client.subscribeProjects({}, { asMailbox: false as const }),
          listener
        ),
    },
    server: {
      getConfig: () =>
        transport.request((client) => client.server.getConfig({})),
      subscribeConfig: (listener) =>
        transport.subscribe(
          (client) =>
            client.subscribeServerConfig({}, { asMailbox: false as const }),
          listener
        ),
      subscribeLifecycle: (listener) =>
        transport.subscribe(
          (client) =>
            client.subscribeServerLifecycle({}, { asMailbox: false as const }),
          listener
        ),
    },
  }
}
