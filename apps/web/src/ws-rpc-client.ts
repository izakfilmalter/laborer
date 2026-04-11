import type {
  Project,
  ProjectsAddInput,
  ProjectsCreateWorkspaceInput,
  ProjectsEvent,
  ProjectsSnapshot,
  ProjectWorkspace,
} from '@laborer/contracts/projects'
import type {
  ServerConfig,
  ServerConfigStreamEvent,
  ServerLifecycleStreamEvent,
} from '@laborer/contracts/server'
import type { ShellOpenInEditorInput } from '@laborer/contracts/shell'
import type {
  TerminalClearInput,
  TerminalCloseInput,
  TerminalEvent,
  TerminalOpenInput,
  TerminalResizeInput,
  TerminalRestartInput,
  TerminalSessionSnapshot,
  TerminalWriteInput,
} from '@laborer/contracts/terminal'

import { WsTransport } from './ws-transport'

type EmptyResult = Record<string, never>

export interface WsRpcClient {
  readonly dispose: () => Promise<void>
  readonly projects: {
    readonly add: (input: ProjectsAddInput) => Promise<Project>
    readonly createWorkspace: (
      input: ProjectsCreateWorkspaceInput
    ) => Promise<ProjectWorkspace>
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
  readonly shell: {
    readonly openInEditor: (
      input: ShellOpenInEditorInput
    ) => Promise<EmptyResult>
  }
  readonly terminal: {
    readonly clear: (input: TerminalClearInput) => Promise<EmptyResult>
    readonly close: (input: TerminalCloseInput) => Promise<EmptyResult>
    readonly onEvent: (listener: (event: TerminalEvent) => void) => () => void
    readonly open: (
      input: TerminalOpenInput
    ) => Promise<TerminalSessionSnapshot>
    readonly resize: (input: TerminalResizeInput) => Promise<EmptyResult>
    readonly restart: (
      input: TerminalRestartInput
    ) => Promise<TerminalSessionSnapshot>
    readonly write: (input: TerminalWriteInput) => Promise<EmptyResult>
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
      createWorkspace: (input) =>
        transport.request((client) => client.projects.createWorkspace(input)),
      list: () => transport.request((client) => client.projects.list({})),
      subscribe: (listener) =>
        transport.subscribe(
          (client) =>
            client.subscribeProjects({}, { asMailbox: false as const }),
          listener
        ),
    },
    shell: {
      openInEditor: (input) =>
        transport.request((client) => client.shell.openInEditor(input)),
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
    terminal: {
      clear: (input) =>
        transport.request((client) => client.terminal.clear(input)),
      close: (input) =>
        transport.request((client) => client.terminal.close(input)),
      onEvent: (listener) =>
        transport.subscribe(
          (client) =>
            client.subscribeTerminalEvents({}, { asMailbox: false as const }),
          listener
        ),
      open: (input) =>
        transport.request((client) => client.terminal.open(input)),
      resize: (input) =>
        transport.request((client) => client.terminal.resize(input)),
      restart: (input) =>
        transport.request((client) => client.terminal.restart(input)),
      write: (input) =>
        transport.request((client) => client.terminal.write(input)),
    },
  }
}
