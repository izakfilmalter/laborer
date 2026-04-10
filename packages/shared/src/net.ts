import net from 'node:net'

import { DEFAULT_SERVER_HOST } from './server'

const closeServer = (server: net.Server) => {
  try {
    server.close()
  } catch {
    // Ignore cleanup failures while probing ports.
  }
}

const tryPort = (port: number, host: string): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = net.createServer()
    let settled = false

    const settle = (callback: () => void) => {
      if (settled) {
        return
      }

      settled = true
      callback()
    }

    server.unref()
    server.once('error', (error) => {
      settle(() => reject(error))
    })
    server.once('listening', () => {
      const address = server.address()
      const resolvedPort =
        typeof address === 'object' && address !== null ? address.port : 0

      server.close(() => {
        settle(() => resolve(resolvedPort))
      })
    })

    server.listen({ host, port })

    const timeout = setTimeout(() => {
      settle(() => reject(new Error('Timed out while probing a port.')))
      closeServer(server)
    }, 1000)
    timeout.unref()
  })

export const findAvailablePort = async (
  preferredPort: number,
  host = DEFAULT_SERVER_HOST
): Promise<number> => {
  try {
    return await tryPort(preferredPort, host)
  } catch {
    return await tryPort(0, host)
  }
}
