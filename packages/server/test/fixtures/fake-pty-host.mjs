import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const stateDir = join(process.env.XDG_STATE_HOME, 'laborer', 'pty-host')
const socketPath = join(stateDir, 'pty-host.sock')
const registrationPath = join(stateDir, 'pty-host.json')
const epoch = randomUUID()
const entryPath = fileURLToPath(import.meta.url)
const version = `1-${createHash('sha256').update(readFileSync(entryPath)).digest('hex').slice(0, 12)}`
mkdirSync(stateDir, { mode: 0o700, recursive: true })
rmSync(socketPath, { force: true })

let stopping = false
const connections = new Set()
const server = createServer((socket) => {
  connections.add(socket)
  socket.on('close', () => connections.delete(socket))
  let buffer = ''
  socket.setEncoding('utf8')
  socket.on('data', (chunk) => {
    buffer += chunk
    let newline = buffer.indexOf('\n')
    while (newline >= 0) {
      const request = JSON.parse(buffer.slice(0, newline))
      buffer = buffer.slice(newline + 1)
      let result
      if (request.method === 'health') {
        result = { epoch, version }
      } else if (request.method === 'listTerminals') {
        result = []
      }
      socket.write(
        `${JSON.stringify({ type: 'response', requestId: request.requestId, result })}\n`
      )
      if (request.method === 'shutdown' && !stopping) {
        stopping = true
        setImmediate(() => {
          rmSync(registrationPath, { force: true })
          for (const connection of connections) {
            connection.destroy()
          }
          server.close(() => {
            rmSync(socketPath, { force: true })
            process.exit(0)
          })
        })
      }
      newline = buffer.indexOf('\n')
    }
  })
})

server.listen(socketPath, () => {
  chmodSync(socketPath, 0o600)
  writeFileSync(
    registrationPath,
    `${JSON.stringify({ epoch, pid: process.pid, socketPath, startedAt: new Date().toISOString(), version })}\n`,
    { mode: 0o600 }
  )
})

const restartSafeStop = () => {
  rmSync(registrationPath, { force: true })
  server.close(() => process.exit(0))
}
process.on('SIGINT', restartSafeStop)
process.on('SIGTERM', restartSafeStop)
