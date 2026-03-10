/**
 * ContainerService e2e tests.
 *
 * These tests exercise the ContainerService with real Docker containers
 * via OrbStack. They verify observable behavior: containers start, stop,
 * pause, unpause, and the worktree bind mount is functional.
 *
 * Requires Docker (OrbStack) to be running on the host.
 */

import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, describe, it } from '@effect/vitest'
import { events, tables } from '@laborer/shared/schema'
import { Effect, Either, Layer } from 'effect'
import { ContainerService } from '../src/services/container-service.js'
import { LaborerStore } from '../src/services/laborer-store.js'
import { TestLaborerStore } from './helpers/test-store.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TestLayer = ContainerService.layer.pipe(
  Layer.provideMerge(TestLaborerStore)
)

/** Create a temp directory, tracking it for cleanup. */
const createTempDir = (prefix: string, tempRoots: string[]): string => {
  const dir = join(
    tmpdir(),
    `laborer-e2e-${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  )
  mkdirSync(dir, { recursive: true })
  tempRoots.push(dir)
  return dir
}

/** Run a docker command synchronously and return stdout. */
const docker = (args: string): string =>
  execSync(`docker ${args}`, { encoding: 'utf-8', timeout: 15_000 }).trim()

/** Get a container's status via docker inspect. */
const containerStatus = (name: string): string => {
  try {
    return docker(`inspect --format '{{.State.Status}}' ${name}`)
  } catch {
    return 'not-found'
  }
}

/** Force-remove a container (cleanup helper). */
const forceRemoveContainer = (name: string): void => {
  try {
    docker(`rm -f ${name}`)
  } catch {
    // ignore — container may not exist
  }
}

/** Exec a command inside a running container and return stdout. */
const dockerExec = (containerName: string, cmd: string): string =>
  docker(`exec ${containerName} ${cmd}`)

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ContainerService e2e', () => {
  it.scoped(
    'createContainer starts a real Docker container with bind-mounted worktree',
    () =>
      Effect.gen(function* () {
        forceRemoveContainer('e2e-create--test-project')

        const tempRoots: string[] = []
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            forceRemoveContainer('e2e-create--test-project')
            for (const root of tempRoots) {
              if (existsSync(root)) {
                rmSync(root, { recursive: true, force: true })
              }
            }
          })
        )

        const worktreePath = createTempDir('worktree-create', tempRoots)
        writeFileSync(join(worktreePath, 'hello.txt'), 'hello from host\n')

        const workspaceId = crypto.randomUUID()
        const { store } = yield* LaborerStore

        // Seed a workspace row so ContainerService can look it up later
        store.commit(
          events.workspaceCreated({
            id: workspaceId,
            projectId: 'project-e2e',
            taskSource: null,
            branchName: 'e2e-create',
            worktreePath,
            port: 0,
            status: 'running',
            origin: 'laborer',
            createdAt: new Date().toISOString(),
            baseSha: null,
          })
        )

        const containerService = yield* ContainerService
        yield* containerService.createContainer({
          workspaceId,
          worktreePath,
          branchName: 'e2e-create',

          projectName: 'test-project',
          devServerConfig: {
            image: 'alpine:latest',
            dockerfile: null,
            network: null,
            workdir: '/app',
          },
        })

        // Verify: container is running
        const status = containerStatus('e2e-create--test-project')
        assert.strictEqual(status, 'running')

        // Verify: bind mount works — file written on host is visible inside
        const output = dockerExec(
          'e2e-create--test-project',
          'cat /app/hello.txt'
        )
        assert.strictEqual(output, 'hello from host')

        // Verify: LiveStore was updated with container info
        const workspaceRows = store.query(
          tables.workspaces.where('id', workspaceId)
        )
        assert.strictEqual(workspaceRows.length, 1)
        assert.isNotNull(workspaceRows[0]?.containerId)
        assert.strictEqual(
          workspaceRows[0]?.containerUrl,
          'e2e-create--test-project.orb.local'
        )
        assert.strictEqual(workspaceRows[0]?.containerImage, 'alpine:latest')
        assert.strictEqual(workspaceRows[0]?.containerStatus, 'running')
      }).pipe(Effect.provide(TestLayer)),
    { timeout: 60_000 }
  )

  it.scoped(
    'destroyContainer stops and removes a real running container',
    () =>
      Effect.gen(function* () {
        forceRemoveContainer('e2e-destroy--test-project')

        const tempRoots: string[] = []
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            forceRemoveContainer('e2e-destroy--test-project')
            for (const root of tempRoots) {
              if (existsSync(root)) {
                rmSync(root, { recursive: true, force: true })
              }
            }
          })
        )

        const worktreePath = createTempDir('worktree-destroy', tempRoots)
        const workspaceId = crypto.randomUUID()
        const { store } = yield* LaborerStore

        store.commit(
          events.workspaceCreated({
            id: workspaceId,
            projectId: 'project-e2e',
            taskSource: null,
            branchName: 'e2e-destroy',
            worktreePath,
            port: 0,
            status: 'running',
            origin: 'laborer',
            createdAt: new Date().toISOString(),
            baseSha: null,
          })
        )

        const containerService = yield* ContainerService

        // Create a container first
        yield* containerService.createContainer({
          workspaceId,
          worktreePath,
          branchName: 'e2e-destroy',

          projectName: 'test-project',
          devServerConfig: {
            image: 'alpine:latest',
            dockerfile: null,
            network: null,
            workdir: '/app',
          },
        })

        // Sanity check — container is running
        assert.strictEqual(
          containerStatus('e2e-destroy--test-project'),
          'running'
        )

        // Destroy it
        yield* containerService.destroyContainer(workspaceId)

        // Verify: container no longer exists
        assert.strictEqual(
          containerStatus('e2e-destroy--test-project'),
          'not-found'
        )

        // Verify: LiveStore was updated — container fields cleared
        const workspaceRows = store.query(
          tables.workspaces.where('id', workspaceId)
        )
        assert.strictEqual(workspaceRows.length, 1)
        assert.strictEqual(workspaceRows[0]?.containerId, null)
        assert.strictEqual(workspaceRows[0]?.containerUrl, null)
        assert.strictEqual(workspaceRows[0]?.containerImage, null)
        assert.strictEqual(workspaceRows[0]?.containerStatus, null)
      }).pipe(Effect.provide(TestLayer)),
    { timeout: 60_000 }
  )

  it.scoped(
    'pauseContainer freezes a running container',
    () =>
      Effect.gen(function* () {
        forceRemoveContainer('e2e-pause--test-project')

        const tempRoots: string[] = []
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            forceRemoveContainer('e2e-pause--test-project')
            for (const root of tempRoots) {
              if (existsSync(root)) {
                rmSync(root, { recursive: true, force: true })
              }
            }
          })
        )

        const worktreePath = createTempDir('worktree-pause', tempRoots)
        const workspaceId = crypto.randomUUID()
        const { store } = yield* LaborerStore

        store.commit(
          events.workspaceCreated({
            id: workspaceId,
            projectId: 'project-e2e',
            taskSource: null,
            branchName: 'e2e-pause',
            worktreePath,
            port: 0,
            status: 'running',
            origin: 'laborer',
            createdAt: new Date().toISOString(),
            baseSha: null,
          })
        )

        const containerService = yield* ContainerService

        yield* containerService.createContainer({
          workspaceId,
          worktreePath,
          branchName: 'e2e-pause',

          projectName: 'test-project',
          devServerConfig: {
            image: 'alpine:latest',
            dockerfile: null,
            network: null,
            workdir: '/app',
          },
        })

        // Pause the container
        yield* containerService.pauseContainer(workspaceId)

        // Verify: Docker reports container as paused
        assert.strictEqual(containerStatus('e2e-pause--test-project'), 'paused')

        // Verify: LiveStore reflects paused state
        const workspaceRows = store.query(
          tables.workspaces.where('id', workspaceId)
        )
        assert.strictEqual(workspaceRows[0]?.containerStatus, 'paused')
      }).pipe(Effect.provide(TestLayer)),
    { timeout: 60_000 }
  )

  it.scoped(
    'unpauseContainer resumes a paused container',
    () =>
      Effect.gen(function* () {
        forceRemoveContainer('e2e-unpause--test-project')

        const tempRoots: string[] = []
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            forceRemoveContainer('e2e-unpause--test-project')
            for (const root of tempRoots) {
              if (existsSync(root)) {
                rmSync(root, { recursive: true, force: true })
              }
            }
          })
        )

        const worktreePath = createTempDir('worktree-unpause', tempRoots)
        const workspaceId = crypto.randomUUID()
        const { store } = yield* LaborerStore

        store.commit(
          events.workspaceCreated({
            id: workspaceId,
            projectId: 'project-e2e',
            taskSource: null,
            branchName: 'e2e-unpause',
            worktreePath,
            port: 0,
            status: 'running',
            origin: 'laborer',
            createdAt: new Date().toISOString(),
            baseSha: null,
          })
        )

        const containerService = yield* ContainerService

        yield* containerService.createContainer({
          workspaceId,
          worktreePath,
          branchName: 'e2e-unpause',

          projectName: 'test-project',
          devServerConfig: {
            image: 'alpine:latest',
            dockerfile: null,
            network: null,
            workdir: '/app',
          },
        })

        // Pause first
        yield* containerService.pauseContainer(workspaceId)
        assert.strictEqual(
          containerStatus('e2e-unpause--test-project'),
          'paused'
        )

        // Unpause
        yield* containerService.unpauseContainer(workspaceId)

        // Verify: Docker reports container as running again
        assert.strictEqual(
          containerStatus('e2e-unpause--test-project'),
          'running'
        )

        // Verify: LiveStore reflects running state
        const workspaceRows = store.query(
          tables.workspaces.where('id', workspaceId)
        )
        assert.strictEqual(workspaceRows[0]?.containerStatus, 'running')

        // Verify: container is functional after unpause (can exec commands)
        const output = dockerExec('e2e-unpause--test-project', 'echo alive')
        assert.strictEqual(output, 'alive')
      }).pipe(Effect.provide(TestLayer)),
    { timeout: 60_000 }
  )

  it.scoped(
    'full lifecycle: create -> pause -> unpause -> destroy with LiveStore state at each step',
    () =>
      Effect.gen(function* () {
        const containerName = 'e2e-lifecycle--test-project'
        forceRemoveContainer(containerName)
        const tempRoots: string[] = []
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            forceRemoveContainer(containerName)
            for (const root of tempRoots) {
              if (existsSync(root)) {
                rmSync(root, { recursive: true, force: true })
              }
            }
          })
        )

        const worktreePath = createTempDir('worktree-lifecycle', tempRoots)
        writeFileSync(join(worktreePath, 'index.ts'), 'export const x = 1\n')

        const workspaceId = crypto.randomUUID()
        const { store } = yield* LaborerStore

        store.commit(
          events.workspaceCreated({
            id: workspaceId,
            projectId: 'project-e2e',
            taskSource: null,
            branchName: 'e2e-lifecycle',
            worktreePath,
            port: 0,
            status: 'running',
            origin: 'laborer',
            createdAt: new Date().toISOString(),
            baseSha: null,
          })
        )

        const containerService = yield* ContainerService

        const queryWorkspace = () =>
          store.query(tables.workspaces.where('id', workspaceId))[0]

        // Step 1: Before container creation — no container fields
        const beforeCreate = queryWorkspace()
        assert.strictEqual(beforeCreate?.containerId, null)
        assert.strictEqual(beforeCreate?.containerStatus, null)

        // Step 2: Create container
        yield* containerService.createContainer({
          workspaceId,
          worktreePath,
          branchName: 'e2e-lifecycle',

          projectName: 'test-project',
          devServerConfig: {
            image: 'alpine:latest',
            dockerfile: null,
            network: null,
            workdir: '/app',
          },
        })

        assert.strictEqual(containerStatus(containerName), 'running')
        const afterCreate = queryWorkspace()
        assert.isNotNull(afterCreate?.containerId)
        assert.strictEqual(
          afterCreate?.containerUrl,
          `${containerName}.orb.local`
        )
        assert.strictEqual(afterCreate?.containerStatus, 'running')

        // Verify bind mount — file visible inside container
        const fileContent = dockerExec(containerName, 'cat /app/index.ts')
        assert.strictEqual(fileContent, 'export const x = 1')

        // Step 3: Pause
        yield* containerService.pauseContainer(workspaceId)
        assert.strictEqual(containerStatus(containerName), 'paused')
        assert.strictEqual(queryWorkspace()?.containerStatus, 'paused')
        // Container ID should be preserved while paused
        assert.strictEqual(
          queryWorkspace()?.containerId,
          afterCreate?.containerId
        )

        // Step 4: Unpause
        yield* containerService.unpauseContainer(workspaceId)
        assert.strictEqual(containerStatus(containerName), 'running')
        assert.strictEqual(queryWorkspace()?.containerStatus, 'running')

        // Container is functional after unpause
        const postUnpause = dockerExec(containerName, 'echo ok')
        assert.strictEqual(postUnpause, 'ok')

        // Step 5: Destroy
        yield* containerService.destroyContainer(workspaceId)
        assert.strictEqual(containerStatus(containerName), 'not-found')
        assert.strictEqual(queryWorkspace()?.containerId, null)
        assert.strictEqual(queryWorkspace()?.containerUrl, null)
        assert.strictEqual(queryWorkspace()?.containerImage, null)
        assert.strictEqual(queryWorkspace()?.containerStatus, null)
      }).pipe(Effect.provide(TestLayer)),
    { timeout: 60_000 }
  )

  it.scoped(
    'createContainer fails with a clear error for a nonexistent image',
    () =>
      Effect.gen(function* () {
        forceRemoveContainer('e2e-bad-image--test-project')

        const tempRoots: string[] = []
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            forceRemoveContainer('e2e-bad-image--test-project')
            for (const root of tempRoots) {
              if (existsSync(root)) {
                rmSync(root, { recursive: true, force: true })
              }
            }
          })
        )

        const worktreePath = createTempDir('worktree-bad-image', tempRoots)
        const workspaceId = crypto.randomUUID()
        const { store } = yield* LaborerStore

        store.commit(
          events.workspaceCreated({
            id: workspaceId,
            projectId: 'project-e2e',
            taskSource: null,
            branchName: 'e2e-bad-image',
            worktreePath,
            port: 0,
            status: 'running',
            origin: 'laborer',
            createdAt: new Date().toISOString(),
            baseSha: null,
          })
        )

        const containerService = yield* ContainerService

        const result = yield* containerService
          .createContainer({
            workspaceId,
            worktreePath,
            branchName: 'e2e-bad-image',

            projectName: 'test-project',
            devServerConfig: {
              image: 'nonexistent-image-that-does-not-exist:9999',
              dockerfile: null,
              network: null,
              workdir: '/app',
            },
          })
          .pipe(Effect.either)

        assert.isTrue(Either.isLeft(result))
        if (Either.isLeft(result)) {
          assert.strictEqual(result.left.code, 'CONTAINER_CREATE_FAILED')
        }

        // Verify: no container was left behind
        assert.strictEqual(
          containerStatus('e2e-bad-image--test-project'),
          'not-found'
        )

        // Verify: LiveStore was NOT updated with container info
        const workspaceRows = store.query(
          tables.workspaces.where('id', workspaceId)
        )
        assert.strictEqual(workspaceRows[0]?.containerId, null)
        assert.strictEqual(workspaceRows[0]?.containerStatus, null)
      }).pipe(Effect.provide(TestLayer)),
    { timeout: 60_000 }
  )

  it.scoped(
    'destroyContainer no-ops gracefully when workspace has no container',
    () =>
      Effect.gen(function* () {
        const workspaceId = crypto.randomUUID()
        const { store } = yield* LaborerStore

        store.commit(
          events.workspaceCreated({
            id: workspaceId,
            projectId: 'project-e2e',
            taskSource: null,
            branchName: 'e2e-no-container',
            worktreePath: '/tmp/nonexistent',
            port: 0,
            status: 'running',
            origin: 'laborer',
            createdAt: new Date().toISOString(),
            baseSha: null,
          })
        )

        const containerService = yield* ContainerService

        // Should not throw — just logs and returns
        yield* containerService.destroyContainer(workspaceId)

        // Workspace row should still exist (destroy doesn't delete the workspace)
        const workspaceRows = store.query(
          tables.workspaces.where('id', workspaceId)
        )
        assert.strictEqual(workspaceRows.length, 1)
        assert.strictEqual(workspaceRows[0]?.containerId, null)
      }).pipe(Effect.provide(TestLayer)),
    { timeout: 30_000 }
  )
})
