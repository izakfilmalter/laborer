import { spawn, spawnSync } from 'node:child_process'
import { watch } from 'node:fs'
import { join } from 'node:path'

import { desktopDir, resolveElectronPath } from './electron-launcher.mjs'
import { waitForResources } from './wait-for-resources.mjs'

const port = Number(
  process.env.ELECTRON_RENDERER_PORT ?? process.env.PORT ?? 3001
)
const devServerUrl = `http://localhost:${port}`
const requiredFiles = ['dist-electron/main.js', 'dist-electron/preload.js']
const watchedDirectories = [
  { directory: 'dist-electron', files: new Set(['main.js', 'preload.js']) },
]
const forcedShutdownTimeoutMs = 1500
const restartDebounceMs = 120
const childTreeGracePeriodMs = 1200

await waitForResources({
  baseDir: desktopDir,
  files: requiredFiles,
  tcpPort: port,
})

const { ELECTRON_RUN_AS_NODE: _electronRunAsNode, ...childEnv } = process.env

let shuttingDown = false
let restartTimer = null
let currentApp = null
let restartQueue = Promise.resolve()
const expectedExits = new WeakSet()
const watchers = []

function killChildTreeByPid(pid, signal) {
  if (process.platform === 'win32' || typeof pid !== 'number') {
    return
  }

  spawnSync('pkill', [`-${signal}`, '-P', String(pid)], { stdio: 'ignore' })
}

function cleanupStaleDevApps() {
  if (process.platform === 'win32') {
    return
  }

  spawnSync('pkill', ['-f', '--', `--laborer-dev-root=${desktopDir}`], {
    stdio: 'ignore',
  })
}

function startApp() {
  if (shuttingDown || currentApp !== null) {
    return
  }

  const child = spawn(
    resolveElectronPath(),
    [`--laborer-dev-root=${desktopDir}`, 'dist-electron/main.js'],
    {
      cwd: desktopDir,
      env: {
        ...childEnv,
        VITE_DEV_SERVER_URL: devServerUrl,
      },
      stdio: 'inherit',
    }
  )

  currentApp = child

  child.once('error', () => {
    if (currentApp === child) {
      currentApp = null
    }

    if (!shuttingDown) {
      scheduleRestart()
    }
  })

  child.once('exit', (code, signal) => {
    if (currentApp === child) {
      currentApp = null
    }

    const exitedAbnormally = signal !== null || code !== 0
    const shouldRestart =
      !shuttingDown && exitedAbnormally && !expectedExits.has(child)
    if (shouldRestart) {
      scheduleRestart()
    }
  })
}

async function stopApp() {
  const child = currentApp
  if (!child) {
    return
  }

  currentApp = null
  expectedExits.add(child)

  await new Promise((resolve) => {
    let settled = false

    const finish = () => {
      if (settled) {
        return
      }

      settled = true
      resolve()
    }

    child.once('exit', finish)
    child.kill('SIGTERM')
    killChildTreeByPid(child.pid, 'TERM')

    setTimeout(() => {
      if (settled) {
        return
      }

      child.kill('SIGKILL')
      killChildTreeByPid(child.pid, 'KILL')
      finish()
    }, forcedShutdownTimeoutMs).unref()
  })
}

function scheduleRestart() {
  if (shuttingDown) {
    return
  }

  if (restartTimer) {
    clearTimeout(restartTimer)
  }

  restartTimer = setTimeout(() => {
    restartTimer = null
    restartQueue = restartQueue
      .catch(() => undefined)
      .then(async () => {
        await stopApp()
        if (!shuttingDown) {
          startApp()
        }
      })
  }, restartDebounceMs)
}

function startWatchers() {
  for (const { directory, files } of watchedDirectories) {
    const watcher = watch(
      join(desktopDir, directory),
      { persistent: true },
      (_eventType, filename) => {
        if (typeof filename !== 'string' || !files.has(filename)) {
          return
        }

        scheduleRestart()
      }
    )

    watchers.push(watcher)
  }
}

function killChildTree(signal) {
  if (process.platform === 'win32') {
    return
  }

  spawnSync('pkill', [`-${signal}`, '-P', String(process.pid)], {
    stdio: 'ignore',
  })
}

async function shutdown(exitCode) {
  if (shuttingDown) {
    return
  }

  shuttingDown = true

  if (restartTimer) {
    clearTimeout(restartTimer)
    restartTimer = null
  }

  for (const watcher of watchers) {
    watcher.close()
  }

  await stopApp()
  killChildTree('TERM')
  await new Promise((resolve) => {
    setTimeout(resolve, childTreeGracePeriodMs)
  })
  killChildTree('KILL')

  process.exit(exitCode)
}

startWatchers()
cleanupStaleDevApps()
startApp()

process.once('SIGINT', () => {
  shutdown(130).catch(() => {
    process.exit(130)
  })
})
process.once('SIGTERM', () => {
  shutdown(143).catch(() => {
    process.exit(143)
  })
})
process.once('SIGHUP', () => {
  shutdown(129).catch(() => {
    process.exit(129)
  })
})
