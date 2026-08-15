import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { readDaemonPort } from './global-setup.js'

const daemonPort = readDaemonPort()
const vitePort = process.env.VITE_PORT ?? '2101'

const vite = spawn(
  'bun',
  ['run', 'dev', '--host', '127.0.0.1', '--port', vitePort],
  {
    cwd: join(import.meta.dirname, '..'),
    env: {
      ...process.env,
      LABORER_DAEMON_PORT: String(daemonPort),
      VITE_PORT: vitePort,
    },
    stdio: 'inherit',
  }
)

const forward = (signal: NodeJS.Signals) => vite.kill(signal)
process.once('SIGINT', () => forward('SIGINT'))
process.once('SIGTERM', () => forward('SIGTERM'))
vite.once('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }
  process.exitCode = code ?? 1
})
