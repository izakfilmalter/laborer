const WINDOW_ID_ARG_PREFIX = '--laborer-window-id='

export interface WindowBootstrapContext {
  readonly windowId: string
}

export function createWindowId(): string {
  return crypto.randomUUID()
}

export function buildWindowBootstrapArgs(
  context: WindowBootstrapContext
): string[] {
  return [`${WINDOW_ID_ARG_PREFIX}${context.windowId}`]
}

export function parseWindowBootstrapArgs(
  argv: readonly string[]
): WindowBootstrapContext {
  return {
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
