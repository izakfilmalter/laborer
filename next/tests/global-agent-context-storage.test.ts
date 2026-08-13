import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { assert, describe, it } from '@effect/vitest'
import { Effect, Exit, Fiber, Logger } from 'effect'
import {
  prepareAcpAgentContextSources,
  resolveLaborerConfigRoot,
  resolveLaborerStateRoot,
  SOUL_FILE_NAME,
  USER_PROFILES_DIRECTORY_NAME,
  userProfilePath,
  WORKSPACE_MEMORY_FILE_NAME,
} from '../src/acp-runtime/agent-context.ts'
import { withCrossProcessContextLocks } from '../src/acp-runtime/context-lock.ts'
import {
  laborerMemoryMcpAuthority,
  makeLaborerMemoryMcpServerConfiguration,
  makeLaborerMemoryStore,
  prepareLaborerMemoryMcpRegistration,
} from '../src/acp-runtime/memory-mcp.ts'
import { makeTempDirectoryScoped } from './support/temp-directory.ts'

const ownerOnly = (mode: number): boolean => mode % 0o100 === 0

const exists = async (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false
  )

describe('global Agent context storage', () => {
  it.effect(
    'keeps Markdown outside a repository while runtime state stays under the Laborer root',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped('laborer-context-repo-')
          const configRoot = yield* makeTempDirectoryScoped(
            'laborer-context-global-'
          )
          const stateRoot = yield* makeTempDirectoryScoped(
            'laborer-context-state-'
          )
          yield* Effect.promise(() => mkdir(join(root, '.git')))

          const sources = yield* prepareAcpAgentContextSources({
            configRoot,
            root,
            stateRoot,
            workspaceId: 'TGLOBALREPO',
          })
          const rootEntries = yield* Effect.promise(() =>
            readdir(root, { recursive: true })
          )

          assert.isFalse(rootEntries.some((entry) => entry.endsWith('.md')))
          assert.ok(sources.soulPath.startsWith(`${configRoot}/`))
          assert.ok(sources.workspaceMemoryPath.startsWith(`${configRoot}/`))
          assert.ok(sources.acpConversationStatePath.startsWith(`${root}/`))
          const store = yield* makeLaborerMemoryStore({
            configRoot,
            root,
            stateRoot,
            workspaceId: 'TGLOBALREPO',
          })
          yield* store.mutate({
            operation: 'add',
            target: 'workspace',
            text: 'lock placement proof',
          })
          const configEntries = yield* Effect.promise(() =>
            readdir(configRoot, { recursive: true, withFileTypes: true })
          )
          assert.isTrue(
            configEntries.every(
              (entry) => entry.isDirectory() || entry.name.endsWith('.md')
            )
          )
          assert.isTrue(
            yield* Effect.promise(() => exists(sources.workspaceMemoryLockPath))
          )
          assert.isTrue(
            ownerOnly((yield* Effect.promise(() => stat(configRoot))).mode)
          )
          assert.isTrue(
            ownerOnly(
              (yield* Effect.promise(() => stat(sources.soulPath))).mode
            )
          )
        })
      )
  )

  it.effect(
    'keys Soul by canonical root while workspace context keys only by Slack workspace',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const container = yield* makeTempDirectoryScoped(
            'laborer-context-authority-'
          )
          const configRoot = yield* makeTempDirectoryScoped(
            'laborer-context-authority-global-'
          )
          const stateRoot = yield* makeTempDirectoryScoped(
            'laborer-context-authority-state-'
          )
          const firstRoot = join(container, 'first')
          const secondRoot = join(container, 'second')
          const firstAlias = join(container, 'first-alias')
          yield* Effect.promise(() => mkdir(firstRoot))
          yield* Effect.promise(() => mkdir(secondRoot))
          yield* Effect.promise(() => symlink(firstRoot, firstAlias))

          const first = yield* prepareAcpAgentContextSources({
            configRoot,
            root: firstRoot,
            stateRoot,
            workspaceId: 'TSHAREDROOTS',
          })
          const alias = yield* prepareAcpAgentContextSources({
            configRoot,
            root: firstAlias,
            stateRoot,
            workspaceId: 'TOTHERWORKSPACE',
          })
          const second = yield* prepareAcpAgentContextSources({
            configRoot,
            root: secondRoot,
            stateRoot,
            workspaceId: 'TSHAREDROOTS',
          })
          const isolated = yield* prepareAcpAgentContextSources({
            configRoot,
            root: secondRoot,
            stateRoot,
            workspaceId: 'TISOLATED',
          })

          assert.strictEqual(first.soulPath, alias.soulPath)
          assert.notStrictEqual(first.soulPath, second.soulPath)
          assert.strictEqual(
            first.workspaceMemoryPath,
            second.workspaceMemoryPath
          )
          assert.notStrictEqual(
            second.workspaceMemoryPath,
            isolated.workspaceMemoryPath
          )
          assert.strictEqual(
            first.root,
            yield* Effect.promise(() => realpath(firstRoot))
          )

          const firstStore = yield* makeLaborerMemoryStore({
            configRoot,
            root: firstRoot,
            stateRoot,
            workspaceId: 'TSHAREDROOTS',
          })
          const secondStore = yield* makeLaborerMemoryStore({
            configRoot,
            root: secondRoot,
            stateRoot,
            workspaceId: 'TSHAREDROOTS',
          })
          yield* Effect.all(
            [
              firstStore.mutate({
                operation: 'add',
                target: 'workspace',
                text: 'first root addition',
              }),
              secondStore.mutate({
                operation: 'add',
                target: 'workspace',
                text: 'second root addition',
              }),
            ],
            { concurrency: 2, discard: true }
          )
          const sharedMemory = yield* Effect.promise(() =>
            readFile(first.workspaceMemoryPath, 'utf8')
          )
          assert.ok(sharedMemory.includes('first root addition'))
          assert.ok(sharedMemory.includes('second root addition'))
        })
      )
  )

  it('resolves absolute XDG config/state homes and their home fallbacks', () => {
    assert.strictEqual(
      resolveLaborerConfigRoot({
        environment: { XDG_CONFIG_HOME: '/tmp/xdg-parent' },
        homeDirectory: '/home/example',
      }),
      '/tmp/xdg-parent/laborer'
    )
    for (const xdgConfigHome of ['', 'relative/config'] as const) {
      assert.strictEqual(
        resolveLaborerConfigRoot({
          environment: { XDG_CONFIG_HOME: xdgConfigHome },
          homeDirectory: '/home/example',
        }),
        '/home/example/.config/laborer'
      )
    }
    assert.throws(() =>
      resolveLaborerConfigRoot({ configRoot: 'relative/config' })
    )
    assert.strictEqual(
      resolveLaborerStateRoot({
        environment: { XDG_STATE_HOME: '/tmp/xdg-state-parent' },
        homeDirectory: '/home/example',
      }),
      '/tmp/xdg-state-parent/laborer'
    )
    for (const xdgStateHome of ['', 'relative/state'] as const) {
      assert.strictEqual(
        resolveLaborerStateRoot({
          environment: { XDG_STATE_HOME: xdgStateHome },
          homeDirectory: '/home/example',
        }),
        '/home/example/.local/state/laborer'
      )
    }
    assert.throws(() =>
      resolveLaborerStateRoot({ stateRoot: 'relative/state' })
    )
  })

  it.effect(
    'creates fully missing explicit roots from the nearest safe ancestor without chmodding it',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const ancestor = yield* makeTempDirectoryScoped(
            'laborer-missing-global-roots-'
          )
          const root = yield* makeTempDirectoryScoped(
            'laborer-missing-global-root-project-'
          )
          yield* Effect.promise(() => chmod(ancestor, 0o755))
          const configRoot = join(ancestor, 'config', 'nested', 'laborer')
          const stateRoot = join(ancestor, 'state', 'nested', 'laborer')

          const sources = yield* prepareAcpAgentContextSources({
            configRoot,
            root,
            stateRoot,
            workspaceId: 'TMISSINGROOTS',
          })

          assert.strictEqual(
            (yield* Effect.promise(() => stat(ancestor))).mode % 0o1000,
            0o755
          )
          for (const path of [
            configRoot,
            join(ancestor, 'config'),
            join(ancestor, 'config', 'nested'),
            stateRoot,
            join(ancestor, 'state'),
            join(ancestor, 'state', 'nested'),
          ]) {
            assert.strictEqual(
              (yield* Effect.promise(() => stat(path))).mode % 0o1000,
              0o700
            )
          }
          assert.strictEqual(sources.configRoot, configRoot)
          assert.strictEqual(sources.stateRoot, stateRoot)
        })
      )
  )

  it.effect(
    'prepares shared missing config and state ancestors safely under high concurrency',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const ancestor = yield* makeTempDirectoryScoped(
            'laborer-concurrent-global-roots-'
          )
          const root = yield* makeTempDirectoryScoped(
            'laborer-concurrent-project-root-'
          )
          yield* Effect.promise(() => chmod(ancestor, 0o755))
          const sharedMissing = join(ancestor, 'missing', 'shared')
          const configRoot = join(sharedMissing, 'config', 'laborer')
          const stateRoot = join(sharedMissing, 'state', 'laborer')
          const workspaceIds = Array.from(
            { length: 32 },
            (_, index) => `TCONCURRENT${String(index).padStart(2, '0')}`
          )

          const prepared = yield* Effect.forEach(
            workspaceIds,
            (workspaceId) =>
              prepareAcpAgentContextSources({
                configRoot,
                root,
                stateRoot,
                workspaceId,
              }),
            { concurrency: 'unbounded' }
          )

          assert.strictEqual(prepared.length, workspaceIds.length)
          assert.isTrue(
            prepared.every(
              (sources) =>
                sources.configRoot === configRoot &&
                sources.stateRoot === stateRoot
            )
          )
          assert.strictEqual(
            (yield* Effect.promise(() => stat(ancestor))).mode % 0o1000,
            0o755
          )
          for (const path of [
            join(ancestor, 'missing'),
            sharedMissing,
            join(sharedMissing, 'config'),
            configRoot,
            join(sharedMissing, 'state'),
            stateRoot,
          ]) {
            assert.strictEqual(
              (yield* Effect.promise(() => stat(path))).mode % 0o1000,
              0o700
            )
          }
        })
      ),
    20_000
  )

  it.effect(
    'rejects equal or nested canonical roots before creating context files',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const cases = yield* Effect.forEach(
            [
              'equal',
              'config-under-root',
              'state-under-root',
              'state-under-config',
              'config-under-state',
              'root-under-config',
            ] as const,
            (kind) =>
              Effect.gen(function* () {
                const projectBase = yield* makeTempDirectoryScoped(
                  `laborer-disjoint-${kind}-project-`
                )
                const globalBase = yield* makeTempDirectoryScoped(
                  `laborer-disjoint-${kind}-global-`
                )
                const separate = yield* makeTempDirectoryScoped(
                  `laborer-disjoint-${kind}-separate-`
                )
                let root = projectBase
                let configRoot = globalBase
                let stateRoot = separate
                switch (kind) {
                  case 'equal':
                    configRoot = root
                    break
                  case 'config-under-root':
                    configRoot = join(root, 'global-config')
                    break
                  case 'state-under-root':
                    stateRoot = join(root, 'global-state')
                    break
                  case 'state-under-config':
                    stateRoot = join(configRoot, 'global-state')
                    break
                  case 'config-under-state':
                    configRoot = join(stateRoot, 'global-config')
                    break
                  case 'root-under-config':
                    root = join(configRoot, 'project')
                    break
                  default:
                    return yield* Effect.die('Unexpected disjoint-root case')
                }
                if (!(yield* Effect.promise(() => exists(root)))) {
                  yield* Effect.promise(() => mkdir(root))
                }
                return { configRoot, root, stateRoot }
              }),
            { concurrency: 1 }
          )

          for (const roots of cases) {
            const exit = yield* Effect.exit(
              prepareAcpAgentContextSources({
                ...roots,
                workspaceId: 'TDISJOINT',
              })
            )
            assert.isTrue(Exit.isFailure(exit))
            const rootEntries = yield* Effect.promise(() =>
              readdir(roots.root, { recursive: true })
            )
            assert.isFalse(
              rootEntries.some(
                (entry) => entry.endsWith('.md') || entry === '.laborer-runtime'
              )
            )
          }
        })
      )
  )

  it.effect('rejects overlaps produced by XDG-derived roots', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const parent = yield* makeTempDirectoryScoped(
          'laborer-xdg-overlap-parent-'
        )
        const root = join(parent, 'laborer')
        yield* Effect.promise(() => mkdir(root))
        const separateState = yield* makeTempDirectoryScoped(
          'laborer-xdg-overlap-state-'
        )
        const configRoot = resolveLaborerConfigRoot({
          environment: { XDG_CONFIG_HOME: parent },
        })
        const stateRoot = resolveLaborerStateRoot({
          environment: { XDG_STATE_HOME: separateState },
        })
        assert.strictEqual(configRoot, root)
        assert.isTrue(
          Exit.isFailure(
            yield* Effect.exit(
              prepareAcpAgentContextSources({
                configRoot,
                root,
                stateRoot,
                workspaceId: 'TXDGOVERLAP',
              })
            )
          )
        )

        const shared = yield* makeTempDirectoryScoped(
          'laborer-xdg-config-state-overlap-'
        )
        const derivedConfig = resolveLaborerConfigRoot({
          environment: { XDG_CONFIG_HOME: shared },
        })
        const derivedState = resolveLaborerStateRoot({
          environment: { XDG_STATE_HOME: derivedConfig },
        })
        const separateRoot = yield* makeTempDirectoryScoped(
          'laborer-xdg-overlap-project-'
        )
        assert.isTrue(
          Exit.isFailure(
            yield* Effect.exit(
              prepareAcpAgentContextSources({
                configRoot: derivedConfig,
                root: separateRoot,
                stateRoot: derivedState,
                workspaceId: 'TXDGSTATEOVERLAP',
              })
            )
          )
        )
        assert.isFalse(yield* Effect.promise(() => exists(derivedConfig)))
      })
    )
  )

  it.effect('passes the exact explicit config root through MCP authority', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* makeTempDirectoryScoped('laborer-context-mcp-')
        const configRoot = yield* makeTempDirectoryScoped(
          'laborer-context-mcp-global-'
        )
        const otherConfigRoot = yield* makeTempDirectoryScoped(
          'laborer-context-mcp-other-'
        )
        const stateRoot = yield* makeTempDirectoryScoped(
          'laborer-context-mcp-state-'
        )
        const otherStateRoot = yield* makeTempDirectoryScoped(
          'laborer-context-mcp-other-state-'
        )
        const sources = yield* prepareAcpAgentContextSources({
          configRoot,
          root,
          stateRoot,
          workspaceId: 'TMCPAUTHORITY',
        })
        const server = makeLaborerMemoryMcpServerConfiguration(sources)

        assert.deepStrictEqual(laborerMemoryMcpAuthority(server), {
          configRoot: sources.configRoot,
          root: sources.root,
          stateRoot: sources.stateRoot,
          workspaceId: sources.workspaceId,
        })
        const tampered = {
          ...server,
          env: server.env.map((entry) =>
            entry.name === 'LABORER_MEMORY_CONFIG_ROOT'
              ? { ...entry, value: otherConfigRoot }
              : entry
          ),
        }
        assert.strictEqual(
          (yield* Effect.result(
            prepareLaborerMemoryMcpRegistration(tampered, sources.root)
          ))._tag,
          'Failure'
        )
        const stateTampered = {
          ...server,
          env: server.env.map((entry) =>
            entry.name === 'LABORER_MEMORY_STATE_ROOT'
              ? { ...entry, value: otherStateRoot }
              : entry
          ),
        }
        assert.strictEqual(
          (yield* Effect.result(
            prepareLaborerMemoryMcpRegistration(stateTampered, sources.root)
          ))._tag,
          'Failure'
        )
      })
    )
  )

  it.effect('atomically migrates every legacy Markdown scope', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* makeTempDirectoryScoped('laborer-context-migrate-')
        const configRoot = yield* makeTempDirectoryScoped(
          'laborer-context-migrate-global-'
        )
        const workspaceId = 'TMIGRATEALL'
        const legacyWorkspace = join(
          root,
          '.laborer-runtime',
          'slack-workspaces',
          workspaceId
        )
        const legacyProfiles = join(
          legacyWorkspace,
          USER_PROFILES_DIRECTORY_NAME
        )
        const legacySoul = join(root, SOUL_FILE_NAME)
        const legacyMemory = join(legacyWorkspace, WORKSPACE_MEMORY_FILE_NAME)
        const legacyProfile = join(legacyProfiles, 'U12345678.md')
        const legacyLockPath = `${legacyMemory}.lock.sqlite`
        const runtimeSentinels = [
          join(legacyWorkspace, 'acp-conversations.json'),
          join(legacyWorkspace, 'memory-diagnostics.log'),
          join(legacyWorkspace, 'memory-mcp-readiness-test'),
        ]
        yield* Effect.promise(() => mkdir(legacyProfiles, { recursive: true }))
        yield* Effect.promise(() => writeFile(legacySoul, 'Legacy Soul'))
        yield* Effect.promise(() => writeFile(legacyMemory, 'Legacy memory'))
        yield* Effect.promise(() => writeFile(legacyProfile, 'Legacy profile'))
        yield* Effect.forEach(
          runtimeSentinels,
          (path) => Effect.promise(() => writeFile(path, 'runtime sentinel')),
          { discard: true }
        )
        const legacyLock = new DatabaseSync(legacyLockPath)
        legacyLock.exec(
          'CREATE TABLE lock_guard (singleton INTEGER PRIMARY KEY CHECK (singleton = 1))'
        )
        legacyLock.close()
        const legacyLockIdentity = yield* Effect.promise(() =>
          stat(legacyLockPath)
        )

        const sources = yield* prepareAcpAgentContextSources({
          configRoot,
          root,
          workspaceId,
        })

        assert.strictEqual(
          yield* Effect.promise(() => readFile(sources.soulPath, 'utf8')),
          'Legacy Soul'
        )
        assert.strictEqual(
          yield* Effect.promise(() =>
            readFile(sources.workspaceMemoryPath, 'utf8')
          ),
          'Legacy memory'
        )
        assert.strictEqual(
          yield* Effect.promise(() =>
            readFile(userProfilePath(sources, 'U12345678'), 'utf8')
          ),
          'Legacy profile'
        )
        assert.isFalse(yield* Effect.promise(() => exists(legacySoul)))
        assert.isFalse(yield* Effect.promise(() => exists(legacyMemory)))
        assert.isFalse(yield* Effect.promise(() => exists(legacyProfile)))
        for (const runtimeSentinel of runtimeSentinels) {
          assert.strictEqual(
            yield* Effect.promise(() => readFile(runtimeSentinel, 'utf8')),
            'runtime sentinel'
          )
        }
        assert.strictEqual(
          (yield* Effect.promise(() => stat(legacyLockPath))).ino,
          legacyLockIdentity.ino
        )
        assert.isFalse(
          yield* Effect.promise(() =>
            exists(`${sources.workspaceMemoryPath}.lock.sqlite`)
          )
        )
      })
    )
  )

  it.effect(
    'serializes migration with legacy and global writers without losing either side',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            'laborer-context-migration-locks-'
          )
          const configRoot = yield* makeTempDirectoryScoped(
            'laborer-context-migration-locks-config-'
          )
          const stateRoot = yield* makeTempDirectoryScoped(
            'laborer-context-migration-locks-state-'
          )
          const workspaceId = 'TMIGRATIONLOCKS'
          const initial = yield* prepareAcpAgentContextSources({
            configRoot,
            root,
            stateRoot,
            workspaceId,
          })
          const legacyMemory = join(
            initial.workspaceDirectory,
            WORKSPACE_MEMORY_FILE_NAME
          )
          yield* Effect.promise(() => rm(initial.workspaceMemoryPath))
          yield* Effect.promise(() => writeFile(legacyMemory, 'legacy initial'))

          let releaseLegacy!: () => void
          let legacyReady!: () => void
          const legacyReadyPromise = new Promise<void>((resolveReady) => {
            legacyReady = resolveReady
          })
          const legacyRelease = new Promise<void>((resolveRelease) => {
            releaseLegacy = resolveRelease
          })
          const legacyWriter = withCrossProcessContextLocks({
            lockPaths: [`${legacyMemory}.lock.sqlite`],
            operation: async () => {
              await writeFile(legacyMemory, 'legacy writer final')
              legacyReady()
              await legacyRelease
            },
          })
          yield* Effect.promise(() => legacyReadyPromise)
          const migration = yield* Effect.forkChild(
            prepareAcpAgentContextSources({
              configRoot,
              root,
              stateRoot,
              workspaceId,
            })
          )
          releaseLegacy()
          yield* Effect.promise(() => legacyWriter)
          yield* Fiber.join(migration)
          assert.strictEqual(
            yield* Effect.promise(() =>
              readFile(initial.workspaceMemoryPath, 'utf8')
            ),
            'legacy writer final'
          )

          yield* Effect.promise(() => rm(initial.workspaceMemoryPath))
          yield* Effect.promise(() =>
            writeFile(legacyMemory, 'legacy retained')
          )
          let releaseGlobal!: () => void
          let globalReady!: () => void
          const globalReadyPromise = new Promise<void>((resolveReady) => {
            globalReady = resolveReady
          })
          const globalRelease = new Promise<void>((resolveRelease) => {
            releaseGlobal = resolveRelease
          })
          const globalWriter = withCrossProcessContextLocks({
            lockPaths: [initial.workspaceMemoryLockPath],
            operation: async () => {
              await writeFile(initial.workspaceMemoryPath, 'global writer wins')
              globalReady()
              await globalRelease
            },
          })
          yield* Effect.promise(() => globalReadyPromise)
          const conflictedMigration = yield* Effect.forkChild(
            prepareAcpAgentContextSources({
              configRoot,
              root,
              stateRoot,
              workspaceId,
            })
          )
          releaseGlobal()
          yield* Effect.promise(() => globalWriter)
          yield* Fiber.join(conflictedMigration)
          assert.strictEqual(
            yield* Effect.promise(() =>
              readFile(initial.workspaceMemoryPath, 'utf8')
            ),
            'global writer wins'
          )
          assert.strictEqual(
            yield* Effect.promise(() => readFile(legacyMemory, 'utf8')),
            'legacy retained'
          )
        })
      )
  )

  it.effect(
    'rolls back publication when staged bytes or the legacy path change',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const configRoot = yield* makeTempDirectoryScoped(
            'laborer-context-source-races-config-'
          )
          const stateRoot = yield* makeTempDirectoryScoped(
            'laborer-context-source-races-state-'
          )
          const editedRoot = yield* makeTempDirectoryScoped(
            'laborer-context-source-edit-'
          )
          const editedLegacy = join(editedRoot, SOUL_FILE_NAME)
          yield* Effect.promise(() => writeFile(editedLegacy, 'before edit'))
          const edited = yield* prepareAcpAgentContextSources({
            configRoot,
            root: editedRoot,
            stateRoot,
            testHooks: {
              afterStage: (kind, _sourcePath, stagedPath) =>
                kind === 'soul'
                  ? writeFile(stagedPath, 'edited in place')
                  : Promise.resolve(),
            },
            workspaceId: 'TMIGRATIONEDIT',
          })
          assert.isFalse(yield* Effect.promise(() => exists(edited.soulPath)))
          assert.strictEqual(
            yield* Effect.promise(() => readFile(editedLegacy, 'utf8')),
            'edited in place'
          )

          const replacedRoot = yield* makeTempDirectoryScoped(
            'laborer-context-source-replacement-'
          )
          const replacedLegacy = join(replacedRoot, SOUL_FILE_NAME)
          yield* Effect.promise(() =>
            writeFile(replacedLegacy, 'staged original')
          )
          const replaced = yield* prepareAcpAgentContextSources({
            configRoot,
            root: replacedRoot,
            stateRoot,
            testHooks: {
              afterPublish: (kind, sourcePath) =>
                kind === 'soul'
                  ? writeFile(sourcePath, 'new replacement')
                  : Promise.resolve(),
            },
            workspaceId: 'TMIGRATIONREPLACE',
          })
          assert.isFalse(yield* Effect.promise(() => exists(replaced.soulPath)))
          assert.strictEqual(
            yield* Effect.promise(() => readFile(replacedLegacy, 'utf8')),
            'new replacement'
          )
          assert.strictEqual(
            yield* Effect.promise(() =>
              readFile(`${replacedLegacy}.migration-staged`, 'utf8')
            ),
            'staged original'
          )
        })
      )
  )

  it.effect(
    'rejects invalid UTF-8, oversized, and non-regular legacy sources without hiding them',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const configRoot = yield* makeTempDirectoryScoped(
            'laborer-invalid-migration-config-'
          )
          const stateRoot = yield* makeTempDirectoryScoped(
            'laborer-invalid-migration-state-'
          )
          const cases = [
            {
              content: new Uint8Array([0xc3, 0x28]),
              prefix: 'laborer-invalid-utf8-',
              workspaceId: 'TINVALIDUTF8',
            },
            {
              content: 'a'.repeat(512 * 1024 + 1),
              prefix: 'laborer-invalid-oversized-',
              workspaceId: 'TINVALIDOVERSIZED',
            },
          ] as const
          for (const invalidCase of cases) {
            const root = yield* makeTempDirectoryScoped(invalidCase.prefix)
            const legacy = join(root, SOUL_FILE_NAME)
            yield* Effect.promise(() => writeFile(legacy, invalidCase.content))
            const sources = yield* prepareAcpAgentContextSources({
              configRoot,
              root,
              stateRoot,
              workspaceId: invalidCase.workspaceId,
            })
            assert.isTrue(yield* Effect.promise(() => exists(legacy)))
            assert.isFalse(
              yield* Effect.promise(() => exists(sources.soulPath))
            )
            assert.isFalse(
              yield* Effect.promise(() => exists(`${legacy}.migration-staged`))
            )
          }

          const specialRoot = yield* makeTempDirectoryScoped(
            'laborer-invalid-special-'
          )
          const specialLegacy = join(specialRoot, SOUL_FILE_NAME)
          yield* Effect.promise(() => mkdir(specialLegacy))
          const special = yield* prepareAcpAgentContextSources({
            configRoot,
            root: specialRoot,
            stateRoot,
            workspaceId: 'TINVALIDSPECIAL',
          })
          assert.isTrue(
            (yield* Effect.promise(() => stat(specialLegacy))).isDirectory()
          )
          assert.isFalse(yield* Effect.promise(() => exists(special.soulPath)))
        })
      )
  )

  it.effect(
    'rejects unsafe or excessive profile sets and retries per-profile failures independently',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const configRoot = yield* makeTempDirectoryScoped(
            'laborer-profile-validation-config-'
          )
          const stateRoot = yield* makeTempDirectoryScoped(
            'laborer-profile-validation-state-'
          )
          const unsafeRoot = yield* makeTempDirectoryScoped(
            'laborer-profile-unsafe-name-'
          )
          const unsafeSources = yield* prepareAcpAgentContextSources({
            configRoot,
            root: unsafeRoot,
            stateRoot,
            workspaceId: 'TPROFILEUNSAFE',
          })
          const unsafeLegacyProfiles = join(
            unsafeSources.workspaceDirectory,
            USER_PROFILES_DIRECTORY_NAME
          )
          yield* Effect.promise(() => mkdir(unsafeLegacyProfiles))
          yield* Effect.promise(() =>
            writeFile(
              join(unsafeLegacyProfiles, 'not-a-slack-user.md'),
              'unsafe'
            )
          )
          yield* prepareAcpAgentContextSources({
            configRoot,
            root: unsafeRoot,
            stateRoot,
            workspaceId: 'TPROFILEUNSAFE',
          })
          assert.isTrue(
            yield* Effect.promise(() =>
              exists(join(unsafeLegacyProfiles, 'not-a-slack-user.md'))
            )
          )

          const countRoot = yield* makeTempDirectoryScoped(
            'laborer-profile-count-'
          )
          const countSources = yield* prepareAcpAgentContextSources({
            configRoot,
            root: countRoot,
            stateRoot,
            workspaceId: 'TPROFILECOUNT',
          })
          const countProfiles = join(
            countSources.workspaceDirectory,
            USER_PROFILES_DIRECTORY_NAME
          )
          yield* Effect.promise(() => mkdir(countProfiles))
          yield* Effect.forEach(
            Array.from(
              { length: 1025 },
              (_, index) => `U${String(index).padStart(8, '0')}.md`
            ),
            (name) =>
              Effect.promise(() => writeFile(join(countProfiles, name), name)),
            { concurrency: 32, discard: true }
          )
          yield* prepareAcpAgentContextSources({
            configRoot,
            root: countRoot,
            stateRoot,
            workspaceId: 'TPROFILECOUNT',
          })
          assert.strictEqual(
            (yield* Effect.promise(() => readdir(countProfiles))).length,
            1025
          )

          const loopRoot = yield* makeTempDirectoryScoped(
            'laborer-profile-loop-'
          )
          const loopSources = yield* prepareAcpAgentContextSources({
            configRoot,
            root: loopRoot,
            stateRoot,
            workspaceId: 'TPROFILELOOP',
          })
          const loopProfiles = join(
            loopSources.workspaceDirectory,
            USER_PROFILES_DIRECTORY_NAME
          )
          yield* Effect.promise(() => mkdir(loopProfiles))
          yield* Effect.promise(() =>
            writeFile(join(loopProfiles, 'U11111111.md'), 'retry profile')
          )
          yield* Effect.promise(() =>
            writeFile(join(loopProfiles, 'U22222222.md'), 'successful profile')
          )
          yield* prepareAcpAgentContextSources({
            configRoot,
            root: loopRoot,
            stateRoot,
            testHooks: {
              beforePublish: (_kind, sourcePath) =>
                sourcePath.endsWith('U11111111.md')
                  ? Promise.reject(new Error('injected profile failure'))
                  : Promise.resolve(),
            },
            workspaceId: 'TPROFILELOOP',
          })
          assert.isTrue(
            yield* Effect.promise(() =>
              exists(join(loopProfiles, 'U11111111.md'))
            )
          )
          assert.strictEqual(
            yield* Effect.promise(() =>
              readFile(userProfilePath(loopSources, 'U22222222'), 'utf8')
            ),
            'successful profile'
          )
          yield* prepareAcpAgentContextSources({
            configRoot,
            root: loopRoot,
            stateRoot,
            workspaceId: 'TPROFILELOOP',
          })
          assert.strictEqual(
            yield* Effect.promise(() =>
              readFile(userProfilePath(loopSources, 'U11111111'), 'utf8')
            ),
            'retry profile'
          )
        })
      )
  )

  it.effect(
    'refuses a symlinked legacy User-profile directory without touching external files',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            'laborer-profile-directory-symlink-root-'
          )
          const configRoot = yield* makeTempDirectoryScoped(
            'laborer-profile-directory-symlink-config-'
          )
          const stateRoot = yield* makeTempDirectoryScoped(
            'laborer-profile-directory-symlink-state-'
          )
          const external = yield* makeTempDirectoryScoped(
            'laborer-profile-directory-symlink-external-'
          )
          const externalProfile = join(external, 'U12345678.md')
          yield* Effect.promise(() =>
            writeFile(externalProfile, 'external profile must remain')
          )
          const sources = yield* prepareAcpAgentContextSources({
            configRoot,
            root,
            stateRoot,
            workspaceId: 'TPROFILEDIRLINK',
          })
          const legacyProfilesDirectory = join(
            sources.workspaceDirectory,
            USER_PROFILES_DIRECTORY_NAME
          )
          yield* Effect.promise(() =>
            symlink(external, legacyProfilesDirectory)
          )

          yield* prepareAcpAgentContextSources({
            configRoot,
            root,
            stateRoot,
            workspaceId: 'TPROFILEDIRLINK',
          })

          assert.isTrue(
            (yield* Effect.promise(() =>
              lstat(legacyProfilesDirectory)
            )).isSymbolicLink()
          )
          assert.strictEqual(
            yield* Effect.promise(() => readFile(externalProfile, 'utf8')),
            'external profile must remain'
          )
          assert.isFalse(
            yield* Effect.promise(() =>
              exists(userProfilePath(sources, 'U12345678'))
            )
          )
        })
      )
  )

  it.effect(
    'keeps conflicting legacy data, warns once without paths, and never overwrites global data',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            'laborer-context-conflict-'
          )
          const configRoot = yield* makeTempDirectoryScoped(
            'laborer-context-conflict-global-'
          )
          const workspaceId = 'TMIGRATECONFLICT'
          const sources = yield* prepareAcpAgentContextSources({
            configRoot,
            root,
            workspaceId,
          })
          const legacySoul = join(root, SOUL_FILE_NAME)
          yield* Effect.promise(() =>
            writeFile(sources.soulPath, 'Global wins')
          )
          yield* Effect.promise(() => writeFile(legacySoul, 'Legacy remains'))
          const warnings: string[] = []
          const logger = Logger.make<unknown, void>((options) => {
            if (options.logLevel === 'Warn') {
              warnings.push(String(options.message))
            }
          })

          yield* prepareAcpAgentContextSources({
            configRoot,
            root,
            workspaceId,
          }).pipe(Effect.provide(Logger.layer([logger])))

          assert.strictEqual(warnings.length, 1)
          assert.isFalse(warnings[0]?.includes(root) ?? true)
          assert.strictEqual(
            yield* Effect.promise(() => readFile(sources.soulPath, 'utf8')),
            'Global wins'
          )
          assert.strictEqual(
            yield* Effect.promise(() => readFile(legacySoul, 'utf8')),
            'Legacy remains'
          )
        })
      )
  )

  it.effect(
    'leaves sources recoverable across failed and interrupted publication and rejects symlinks',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            'laborer-context-interruption-'
          )
          const configRoot = yield* makeTempDirectoryScoped(
            'laborer-context-interruption-global-'
          )
          const legacySoul = join(root, SOUL_FILE_NAME)
          yield* Effect.promise(() => writeFile(legacySoul, 'Retry me'))
          const failed = yield* prepareAcpAgentContextSources({
            configRoot,
            root,
            testHooks: {
              beforePublish: () =>
                Promise.reject(new Error('injected pre-publication failure')),
            },
            workspaceId: 'TMIGRATEFAILURE',
          })
          assert.isTrue(yield* Effect.promise(() => exists(legacySoul)))
          assert.isFalse(yield* Effect.promise(() => exists(failed.soulPath)))

          const retried = yield* prepareAcpAgentContextSources({
            configRoot,
            root,
            workspaceId: 'TMIGRATEFAILURE',
          })
          assert.strictEqual(
            yield* Effect.promise(() => readFile(retried.soulPath, 'utf8')),
            'Retry me'
          )
          assert.isFalse(yield* Effect.promise(() => exists(legacySoul)))

          const interruptedRoot = yield* makeTempDirectoryScoped(
            'laborer-context-after-publish-'
          )
          const interruptedLegacy = join(interruptedRoot, SOUL_FILE_NAME)
          yield* Effect.promise(() =>
            writeFile(interruptedLegacy, 'Published before interruption')
          )
          const interrupted = yield* prepareAcpAgentContextSources({
            configRoot,
            root: interruptedRoot,
            testHooks: {
              afterPublish: () =>
                Promise.reject(
                  new Error('injected post-publication interruption')
                ),
            },
            workspaceId: 'TMIGRATEINTERRUPTED',
          })
          assert.strictEqual(
            yield* Effect.promise(() => readFile(interrupted.soulPath, 'utf8')),
            'Published before interruption'
          )
          assert.isFalse(yield* Effect.promise(() => exists(interruptedLegacy)))
          assert.isTrue(
            yield* Effect.promise(() =>
              exists(`${interruptedLegacy}.migration-staged`)
            )
          )
          yield* prepareAcpAgentContextSources({
            configRoot,
            root: interruptedRoot,
            workspaceId: 'TMIGRATEINTERRUPTED',
          })
          assert.isFalse(
            yield* Effect.promise(() =>
              exists(`${interruptedLegacy}.migration-staged`)
            )
          )

          const unsafeRoot = yield* makeTempDirectoryScoped(
            'laborer-context-unsafe-'
          )
          const externalDirectory = yield* makeTempDirectoryScoped(
            'laborer-context-unsafe-target-'
          )
          const external = join(externalDirectory, 'unsafe-soul-target.md')
          yield* Effect.promise(() => writeFile(external, 'must not traverse'))
          yield* Effect.promise(() =>
            symlink(external, join(unsafeRoot, SOUL_FILE_NAME))
          )
          const unsafe = yield* prepareAcpAgentContextSources({
            configRoot,
            root: unsafeRoot,
            workspaceId: 'TMIGRATEUNSAFE',
          })
          assert.isFalse(yield* Effect.promise(() => exists(unsafe.soulPath)))
          assert.strictEqual(
            yield* Effect.promise(() => readFile(external, 'utf8')),
            'must not traverse'
          )
        })
      )
  )
})
