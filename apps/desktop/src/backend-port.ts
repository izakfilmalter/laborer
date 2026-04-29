import { createServer } from 'node:net'

export const DEFAULT_DESKTOP_BACKEND_PORT = 3773
const MAX_TCP_PORT = 65_535

export interface ResolveDesktopBackendPortOptions {
  readonly canListenOnHost?: (port: number, host: string) => Promise<boolean>
  readonly host: string
  readonly maxPort?: number
  readonly requiredHosts?: readonly string[]
  readonly startPort?: number
}

const isValidPort = (port: number): boolean =>
  Number.isInteger(port) && port >= 1 && port <= MAX_TCP_PORT

const normalizeHosts = (
  host: string,
  requiredHosts: readonly string[]
): readonly string[] =>
  Array.from(
    new Set(
      [host, ...requiredHosts]
        .map((candidate) => candidate.trim())
        .filter((candidate) => candidate.length > 0)
    )
  )

const defaultCanListenOnHost = async (
  port: number,
  host: string
): Promise<boolean> =>
  await new Promise<boolean>((resolve) => {
    const server = createServer()
    server.once('error', () => {
      resolve(false)
    })
    server.listen(port, host, () => {
      server.close(() => resolve(true))
    })
  })

async function canListenOnAllHosts(
  port: number,
  hosts: readonly string[],
  canListenOnHost: (port: number, host: string) => Promise<boolean>
): Promise<boolean> {
  for (const candidateHost of hosts) {
    if (!(await canListenOnHost(port, candidateHost))) {
      return false
    }
  }

  return true
}

export async function resolveDesktopBackendPort({
  canListenOnHost = defaultCanListenOnHost,
  host,
  maxPort = MAX_TCP_PORT,
  requiredHosts = [],
  startPort = DEFAULT_DESKTOP_BACKEND_PORT,
}: ResolveDesktopBackendPortOptions): Promise<number> {
  if (!isValidPort(startPort)) {
    throw new Error(`Invalid desktop backend start port: ${String(startPort)}`)
  }

  if (!isValidPort(maxPort)) {
    throw new Error(`Invalid desktop backend max port: ${String(maxPort)}`)
  }

  if (maxPort < startPort) {
    throw new Error(
      `Desktop backend max port ${String(maxPort)} is below start port ${String(startPort)}`
    )
  }

  const hostsToCheck = normalizeHosts(host, requiredHosts)

  for (let port = startPort; port <= maxPort; port += 1) {
    if (await canListenOnAllHosts(port, hostsToCheck, canListenOnHost)) {
      return port
    }
  }

  throw new Error(
    `No desktop backend port is available on hosts ${hostsToCheck.join(', ')} between ${String(startPort)} and ${String(maxPort)}`
  )
}
