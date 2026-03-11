import { randomBytes } from 'node:crypto'
import { createServer } from 'node:net'

/**
 * Reserve an ephemeral port on the loopback interface.
 *
 * Binds a TCP server to port 0 on 127.0.0.1, records the OS-assigned port,
 * then immediately closes the server. There is a small race window between
 * closing and the child process binding, but this is the standard approach
 * used by Electron apps, VS Code, and other desktop tools.
 */
export function reservePort(host = '127.0.0.1'): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()

    server.once('error', (error) => {
      reject(new Error('Failed to reserve ephemeral port', { cause: error }))
    })

    server.listen(0, host, () => {
      const address = server.address()
      const port =
        typeof address === 'object' && address !== null ? address.port : 0

      server.close(() => {
        if (port > 0) {
          resolve(port)
        } else {
          reject(new Error('Failed to reserve ephemeral port: port is 0'))
        }
      })
    })
  })
}

/**
 * Bootstrap result containing the ports and auth token needed
 * for child process communication.
 */
export interface ServicePorts {
  /** Random auth token to secure child process communication. */
  readonly authToken: string
  /** Port for the server (HTTP + WebSocket for LiveStore sync + RPC). */
  readonly serverPort: number
  /** Port for the terminal service (HTTP + WebSocket for PTY I/O). */
  readonly terminalPort: number
}

/**
 * Reserve ephemeral ports for the server and terminal services,
 * and generate a random auth token.
 *
 * The MCP service communicates over stdio, so it doesn't need a port.
 */
export async function reserveServicePorts(): Promise<ServicePorts> {
  const [serverPort, terminalPort] = await Promise.all([
    reservePort(),
    reservePort(),
  ])

  const authToken = randomBytes(24).toString('hex')

  return { serverPort, terminalPort, authToken }
}
