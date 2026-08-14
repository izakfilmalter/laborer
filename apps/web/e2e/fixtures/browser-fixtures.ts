import { type ChildProcess, spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DaemonRpcs } from '@laborer/shared/rpc'
import { test as base, expect as playwrightExpect } from '@playwright/test'
import { Effect, Layer } from 'effect'
import { RpcClient, RpcSerialization } from 'effect/unstable/rpc'
import {
  layerWebSocket,
  layerWebSocketConstructorGlobal,
} from 'effect/unstable/socket/Socket'
import { initRepo } from '../../../../packages/server/test/helpers/git-helpers.js'
import { TerminalHelper } from './terminal-helper.js'

const MAX_DIAGNOSTICS_LENGTH = 64 * 1024
const STATE_FILE = join(tmpdir(), 'laborer-e2e-state.json')
export const expect = playwrightExpect

interface SetupState {
  readonly daemonPort: number
}

const MakeDaemonClient = RpcClient.make(DaemonRpcs)
type DaemonClient = Effect.Success<typeof MakeDaemonClient>

export interface DaemonRpc {
  readonly run: <A, E>(
    operation: (client: DaemonClient) => Effect.Effect<A, E>
  ) => Promise<A>
}

export interface DaemonFixture {
  readonly restart: () => Promise<void>
  readonly rpc: DaemonRpc
  readonly stateDir: string
  readonly stop: () => Promise<void>
  readonly url: string
}

export interface SeededWorkspace {
  readonly branchName: string
  readonly projectId: string
  readonly repoPath: string
  readonly workspaceId: string
}

interface BrowserFixtures {
  readonly app: undefined
  readonly seededWorkspace: SeededWorkspace
  readonly terminal: TerminalHelper
}

interface BrowserWorkerFixtures {
  readonly daemon: DaemonFixture
}

const stopChild = async (child: ChildProcess | undefined): Promise<void> => {
  if (!child || child.exitCode !== null) {
    return
  }
  child.kill('SIGTERM')
  await new Promise<void>((resolveExit) => {
    const force = setTimeout(() => child.kill('SIGKILL'), 5000)
    child.once('exit', () => {
      clearTimeout(force)
      resolveExit()
    })
  })
}

export const test = base.extend<BrowserFixtures, BrowserWorkerFixtures>({
  daemon: [
    // biome-ignore lint/correctness/noEmptyPattern: Playwright requires object destructuring for fixture dependencies
    async ({}, use) => {
      const { daemonPort } = JSON.parse(
        readFileSync(STATE_FILE, 'utf8')
      ) as SetupState
      const reuseDevStack = process.env.LABORER_E2E_REUSE_DEV_STACK === '1'
      const stateDir = reuseDevStack
        ? (process.env.LABORER_E2E_STATE_DIR ?? '')
        : await mkdtemp(join(tmpdir(), 'laborer-e2e-daemon-'))
      const daemonTmpDir = join(stateDir, 'tmp')
      if (!reuseDevStack) {
        await mkdir(daemonTmpDir, { recursive: true })
      }
      const daemonPath = resolve(
        import.meta.dirname,
        '../../../../packages/server/dist/daemon-main.mjs'
      )
      const url = `http://127.0.0.1:${String(daemonPort)}`
      let child: ChildProcess | undefined
      let diagnostics = ''

      const start = async () => {
        if (reuseDevStack) {
          await expect
            .poll(async () => {
              try {
                return (
                  await fetch(`${url}/health`, {
                    signal: AbortSignal.timeout(1000),
                  })
                ).ok
              } catch {
                return false
              }
            })
            .toBe(true)
          return
        }
        if (child && child.exitCode === null) {
          return
        }
        diagnostics = ''
        child = spawn(process.execPath, [daemonPath], {
          env: {
            ...process.env,
            DATA_DIR: join(stateDir, 'data'),
            HOME: stateDir,
            LABORER_DAEMON_PORT: String(daemonPort),
            LABORER_FILE_WATCHER_BACKEND: 'fs',
            NODE_ENV: 'test',
            TMPDIR: daemonTmpDir,
            XDG_CONFIG_HOME: join(stateDir, 'config'),
            XDG_STATE_HOME: stateDir,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        const appendDiagnostics = (chunk: unknown) => {
          diagnostics = `${diagnostics}${String(chunk)}`.slice(
            -MAX_DIAGNOSTICS_LENGTH
          )
          if (process.env.LABORER_E2E_DAEMON_LOGS === '1') {
            process.stderr.write(String(chunk))
          }
        }
        child.stdout?.on('data', appendDiagnostics)
        child.stderr?.on('data', appendDiagnostics)

        await expect
          .poll(
            async () => {
              if (child?.exitCode !== null) {
                throw new Error(
                  `Daemon exited before readiness (${String(child?.exitCode)})\n${diagnostics}`
                )
              }
              try {
                const response = await fetch(`${url}/health`, {
                  signal: AbortSignal.timeout(1000),
                })
                return response.ok
              } catch {
                return false
              }
            },
            { timeout: 30_000, message: `daemon readiness\n${diagnostics}` }
          )
          .toBe(true)
      }

      const stop = async () => {
        if (reuseDevStack) {
          return
        }
        await stopChild(child)
        child = undefined
      }

      const socket = layerWebSocket(
        `ws://127.0.0.1:${String(daemonPort)}/ws`
      ).pipe(Layer.provide(layerWebSocketConstructorGlobal))
      const protocol = RpcClient.layerProtocolSocket({
        retryTransientErrors: false,
      }).pipe(Layer.provide(Layer.merge(socket, RpcSerialization.layerJson)))
      const rpc: DaemonRpc = {
        run: <A, E>(operation: (client: DaemonClient) => Effect.Effect<A, E>) =>
          Effect.runPromise(
            Effect.gen(function* () {
              const client = yield* MakeDaemonClient
              return yield* operation(client)
            }).pipe(Effect.provide(protocol), Effect.scoped)
          ),
      }

      await start()
      await use({
        rpc,
        stateDir,
        url,
        restart: async () => {
          if (reuseDevStack) {
            throw new Error('The fixture cannot restart an opted-in dev daemon')
          }
          await stop()
          await start()
        },
        stop,
      })
      await stop()
      if (!reuseDevStack) {
        await rm(stateDir, { recursive: true, force: true })
      }
    },
    { scope: 'worker' },
  ],

  seededWorkspace: async ({ daemon }, use) => {
    const tempRoots: string[] = []
    const repoPath = initRepo('browser-e2e', tempRoots)
    const branchName = `e2e-terminal-${crypto.randomUUID()}`
    const seeded = await daemon.rpc.run((client) =>
      Effect.gen(function* () {
        const project = yield* client['project.add']({ repoPath })
        const workspace = yield* client['workspace.create']({
          branchName,
          projectId: project.id,
        })
        yield* client['task.create']({
          projectId: project.id,
          status: 'todo',
          text: `Terminal gate ${branchName}`,
        })
        return {
          branchName,
          projectId: project.id,
          repoPath,
          workspaceId: workspace.id,
        }
      })
    )

    await use(seeded)
    for (const root of tempRoots) {
      await rm(root, { recursive: true, force: true })
    }
  },

  app: async ({ page, seededWorkspace }, use) => {
    await page.goto('/')
    await expect(
      page.getByTestId(`workspace-card-${seededWorkspace.branchName}`).first()
    ).toBeVisible({ timeout: 30_000 })
    await use(undefined)
  },

  terminal: async ({ page }, use) => {
    await use(new TerminalHelper(page))
  },
})
