const SERVER_URL_ARG_PREFIX = '--laborer-server-url='
const TERMINAL_URL_ARG_PREFIX = '--laborer-terminal-url='
const WINDOW_ID_ARG_PREFIX = '--laborer-window-id='

export interface WindowBootstrapContext {
  readonly serverUrl: string
  readonly terminalUrl: string
  readonly windowId: string
}

export function createWindowId(): string {
  return crypto.randomUUID()
}

export function buildWindowBootstrapArgs(
  context: WindowBootstrapContext
): string[] {
  return [
    `${SERVER_URL_ARG_PREFIX}${context.serverUrl}`,
    `${TERMINAL_URL_ARG_PREFIX}${context.terminalUrl}`,
    `${WINDOW_ID_ARG_PREFIX}${context.windowId}`,
  ]
}

export function parseWindowBootstrapArgs(
  argv: readonly string[]
): WindowBootstrapContext {
  return {
    serverUrl: getArgValue(argv, SERVER_URL_ARG_PREFIX),
    terminalUrl: getArgValue(argv, TERMINAL_URL_ARG_PREFIX),
    windowId: getArgValue(argv, WINDOW_ID_ARG_PREFIX),
  }
}

function getArgValue(argv: readonly string[], prefix: string): string {
  for (const arg of argv) {
    if (arg.startsWith(prefix)) {
      return arg.slice(prefix.length)
    }
  }

  return ''
}
