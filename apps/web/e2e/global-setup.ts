/**
 * Playwright Global Setup
 *
 * Runs once before all E2E tests:
 * 1. Creates a temp git repository with an initial commit (for project tests)
 * 2. Checks if services are already running (developer has turbo dev open)
 * 3. If not, starts `turbo dev` with DATA_DIR pointing to a temp directory
 * 4. Polls health endpoints until all 3 services are healthy
 *
 * Stores process references and temp paths in a state file for teardown.
 *
 * @see PRD-e2e-test-coverage.md — Global Setup / Teardown
 */

import { execSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { FullConfig } from '@playwright/test'

/** Path to the state file shared between setup and teardown. */
const STATE_FILE = join(tmpdir(), 'laborer-e2e-state.json')

/** Maximum time to wait for all services to become healthy (ms). */
const HEALTH_CHECK_TIMEOUT = 120_000

/** Interval between health check polls (ms). */
const HEALTH_CHECK_INTERVAL = 2000

const DEFAULT_WEB_PORT = 3001
const DEFAULT_SERVER_PORT = 3000
const DEFAULT_TERMINAL_PORT = 3002

/**
 * Check if a service is already running by attempting a single fetch.
 */
async function isServiceRunning(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(3000),
    })
    return response.ok
  } catch {
    return false
  }
}

function canListenOnPort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer()
    server.once('error', () => {
      resolve(false)
    })
    server.once('listening', () => {
      server.close(() => resolve(true))
    })
    server.listen(port)
  })
}

async function findAvailablePort(preferredPort: number): Promise<number> {
  if (await canListenOnPort(preferredPort)) {
    return preferredPort
  }

  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Failed to allocate a free port')))
        return
      }
      const { port } = address
      server.close((error) => {
        if (error) {
          reject(error)
          return
        }
        resolve(port)
      })
    })
  })
}

/**
 * Poll a URL until it returns a 200 response or timeout is reached.
 * Returns true if healthy, false if timed out.
 */
async function pollEndpoint(
  url: string,
  timeoutMs: number,
  intervalMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(5000),
      })
      if (response.ok) {
        return true
      }
    } catch {
      // Service not ready yet — retry
    }
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  return false
}

export default async function globalSetup(_config: FullConfig): Promise<void> {
  // 1. Create a temp git repository with an initial commit
  const tempRepoDir = mkdtempSync(join(tmpdir(), 'laborer-e2e-repo-'))
  execSync('git init', { cwd: tempRepoDir, stdio: 'pipe' })
  execSync("git config user.email 'e2e@test.local'", {
    cwd: tempRepoDir,
    stdio: 'pipe',
  })
  execSync("git config user.name 'E2E Test'", {
    cwd: tempRepoDir,
    stdio: 'pipe',
  })
  writeFileSync(join(tempRepoDir, 'README.md'), '# E2E Test Repo\n')
  // Ignore laborer.json so that config.update writes during settings tests
  // don't cause DIRTY_WORKING_TREE errors in workspace creation tests.
  writeFileSync(join(tempRepoDir, '.gitignore'), 'laborer.json\n')
  execSync('git add .', { cwd: tempRepoDir, stdio: 'pipe' })
  execSync('git commit -m "Initial commit"', {
    cwd: tempRepoDir,
    stdio: 'pipe',
  })

  // 2. Check if services are already running
  const [webRunning, serverRunning, terminalRunning] = await Promise.all([
    isServiceRunning(`http://localhost:${DEFAULT_WEB_PORT}`),
    isServiceRunning(`http://localhost:${DEFAULT_SERVER_PORT}`),
    isServiceRunning(`http://localhost:${DEFAULT_TERMINAL_PORT}`),
  ])

  const allRunning = webRunning && serverRunning && terminalRunning
  let turboPid: number | null = null
  let dataDirBase: string | null = null
  const webPort = DEFAULT_WEB_PORT
  let serverPort = DEFAULT_SERVER_PORT
  let terminalPort = DEFAULT_TERMINAL_PORT

  if (allRunning) {
    // Services already running — skip starting turbo dev.
    // This is the common developer workflow where turbo dev is already open.
    process.stdout.write(
      '[e2e] All services already running, skipping turbo dev startup\n'
    )
  } else {
    // 3. Start turbo dev with isolated DATA_DIR
    ;[serverPort, terminalPort] = await Promise.all([
      findAvailablePort(DEFAULT_SERVER_PORT),
      findAvailablePort(DEFAULT_TERMINAL_PORT),
    ])

    dataDirBase = mkdtempSync(join(tmpdir(), 'laborer-e2e-data-'))
    mkdirSync(join(dataDirBase, 'data'), { recursive: true })

    const monorepoRoot = resolve(import.meta.dirname, '../../..')
    const webUrl = `http://localhost:${webPort}`
    const serverUrl = `http://localhost:${serverPort}`
    const terminalUrl = `http://localhost:${terminalPort}`
    const turboProcess = spawn('turbo', ['dev', '--env-mode=loose'], {
      cwd: monorepoRoot,
      stdio: 'pipe',
      env: {
        ...process.env,
        DATA_DIR: dataDirBase,
        PORT: String(serverPort),
        TERMINAL_PORT: String(terminalPort),
        VITE_SERVER_URL: serverUrl,
        WEB_PORT: String(webPort),
      },
      detached: true,
    })

    turboPid = turboProcess.pid ?? null

    // Log turbo output for debugging
    turboProcess.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      if (
        text.includes('error') ||
        text.includes('Error') ||
        text.includes('listening') ||
        text.includes('ready') ||
        text.includes('started')
      ) {
        process.stdout.write(`[turbo] ${text}`)
      }
    })

    turboProcess.stderr?.on('data', (chunk: Buffer) => {
      process.stderr.write(`[turbo:err] ${chunk.toString()}`)
    })

    // Give turbo a moment to start spawning child processes
    await new Promise((r) => setTimeout(r, 3000))

    // 4. Poll health endpoints until all 3 services are healthy
    interface ServiceStatus {
      server: boolean
      terminal: boolean
      web: boolean
    }

    const status: ServiceStatus = {
      web: false,
      server: false,
      terminal: false,
    }

    const checks = await Promise.all([
      pollEndpoint(webUrl, HEALTH_CHECK_TIMEOUT, HEALTH_CHECK_INTERVAL).then(
        (ok) => {
          status.web = ok
          return ok
        }
      ),
      pollEndpoint(serverUrl, HEALTH_CHECK_TIMEOUT, HEALTH_CHECK_INTERVAL).then(
        (ok) => {
          status.server = ok
          return ok
        }
      ),
      pollEndpoint(
        terminalUrl,
        HEALTH_CHECK_TIMEOUT,
        HEALTH_CHECK_INTERVAL
      ).then((ok) => {
        status.terminal = ok
        return ok
      }),
    ])

    if (!checks.every(Boolean)) {
      const failed = Object.entries(status)
        .filter(([, ok]) => !ok)
        .map(([name]) => name)
      turboProcess.kill('SIGTERM')
      throw new Error(
        `E2E setup: Services failed to start: ${failed.join(', ')}. ` +
          'Check that turbo dev can start all services.'
      )
    }
  }

  // 5. Save state for teardown and test access
  const state = {
    webPort,
    serverPort,
    terminalPort,
    turboPid,
    dataDirBase,
    tempRepoDir,
    servicesWereAlreadyRunning: allRunning,
  }
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))

  // Set env vars so tests can access the temp repo path
  process.env.E2E_TEMP_REPO_DIR = tempRepoDir
  process.env.E2E_DATA_DIR = dataDirBase ?? ''
}
