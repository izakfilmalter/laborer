import { execFile } from 'node:child_process'
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { Effect } from 'effect'
import { afterEach, describe, expect, it } from 'vitest'
import { makeGitWorktreeManager } from '../src/adapters/git-worktree-manager.ts'
import { WorktreeProvisioningUncertain } from '../src/reference-coding-application.ts'

const execFilePromise = promisify(execFile)
const sandboxes = new Set<string>()

interface RepositoryFixture {
  readonly repository: string
  readonly sandbox: string
  readonly sourceDirectory: string
}

const git = async (
  repository: string,
  args: readonly string[]
): Promise<string> => {
  const result = await execFilePromise('git', ['-C', repository, ...args], {
    encoding: 'utf8',
  })
  return result.stdout.trim()
}

const makeRepository = async (): Promise<RepositoryFixture> => {
  const sandbox = await mkdtemp(
    join(await realpath(tmpdir()), 'laborer-git-worktree-')
  )
  sandboxes.add(sandbox)
  const repository = join(sandbox, 'laborer')
  const sourceDirectory = join(repository, 'app')
  await mkdir(sourceDirectory, { recursive: true })
  await Promise.all([
    writeFile(join(repository, '.gitignore'), '.env.local\n'),
    writeFile(join(repository, 'README.md'), 'integration fixture\n'),
    writeFile(join(sourceDirectory, 'package.json'), '{}\n'),
    writeFile(join(sourceDirectory, '.env.local'), 'SECRET=value\n', {
      mode: 0o600,
    }),
  ])
  await git(repository, ['init', '-b', 'main'])
  await git(repository, ['config', 'user.email', 'test@example.com'])
  await git(repository, ['config', 'user.name', 'Worktree Test'])
  await git(repository, ['add', '.'])
  await git(repository, ['commit', '-m', 'initial'])
  return { repository, sandbox, sourceDirectory }
}

const effectFails = async (
  effect: Effect.Effect<unknown, unknown>
): Promise<boolean> => {
  const exit = await Effect.runPromiseExit(effect)
  return exit._tag === 'Failure'
}

afterEach(async () => {
  await Promise.all(
    [...sandboxes].map((sandbox) =>
      rm(sandbox, { force: true, recursive: true })
    )
  )
  sandboxes.clear()
})

describe('Git WorktreeManager', () => {
  it('creates the deterministic sibling worktree and Laborer branch', async () => {
    const fixture = await makeRepository()
    const manager = makeGitWorktreeManager({
      repository: fixture.sourceDirectory,
    })

    const worktree = await Effect.runPromise(
      manager.create({
        conversationId: 'conversation-1',
        executionId: 'execution-1',
        operationId: 'operation-1',
        worktreeName: 'feature-safe-worktree',
      })
    )

    const expectedPath = join(
      fixture.sandbox,
      'laborer.worktrees',
      'feature-safe-worktree',
      'app'
    )
    expect(worktree).toEqual({ workingDirectory: expectedPath })
    expect(await git(dirname(expectedPath), ['branch', '--show-current'])).toBe(
      'laborer/feature-safe-worktree'
    )
    expect(await readFile(join(expectedPath, '.env.local'), 'utf8')).toBe(
      'SECRET=value\n'
    )
    expect((await stat(join(expectedPath, '.env.local'))).mode % 512).toBe(
      0o600
    )
    expect(
      JSON.parse(
        await readFile(
          join(dirname(expectedPath), '.laborer-worktree-owner.json'),
          'utf8'
        )
      )
    ).toMatchObject({
      conversationId: 'conversation-1',
      executionId: 'execution-1',
      operationId: 'operation-1',
      schemaVersion: 1,
      worktreeName: 'feature-safe-worktree',
    })
  })

  it('returns typed uncertainty after git add side effects and repairs only the exact checkout', async () => {
    const fixture = await makeRepository()
    const hookPath = join(fixture.repository, '.git', 'hooks', 'post-checkout')
    await writeFile(
      hookPath,
      `#!/bin/sh
if [ "$(git branch --show-current)" = "laborer/ambiguous-add" ]; then
  mkdir -p app
  printf 'CONFLICT=temporary\n' > app/.env.local
  chmod 600 app/.env.local
fi
`,
      { mode: 0o700 }
    )
    const manager = makeGitWorktreeManager({
      repository: fixture.sourceDirectory,
    })
    const request = {
      conversationId: 'conversation-ambiguous',
      executionId: 'execution-ambiguous',
      worktreeName: 'ambiguous-add',
    } as const

    const creation = await Effect.runPromise(
      Effect.result(manager.create(request))
    )

    expect(creation._tag).toBe('Failure')
    if (creation._tag !== 'Failure') {
      throw new Error('ambiguous worktree creation unexpectedly succeeded')
    }
    expect(creation.failure).toBeInstanceOf(WorktreeProvisioningUncertain)
    if (manager.recover === undefined) {
      throw new Error('recover is unavailable')
    }
    expect(manager.inspect).toBeDefined()
    if (manager.inspect === undefined) {
      throw new Error('inspect is unavailable')
    }
    expect(
      await Effect.runPromise(
        manager.inspect({
          ...request,
          creationState: 'staged',
          workingDirectory: join(
            fixture.sandbox,
            'laborer.worktrees',
            request.worktreeName,
            'app'
          ),
        })
      )
    ).toEqual({
      certainty: 'definitive',
      evidence: 'exact-owned-incomplete',
      status: 'recoverable',
    })
    const recovered = await Effect.runPromise(manager.recover(request))
    expect(
      await readFile(join(recovered.workingDirectory, '.env.local'), 'utf8')
    ).toBe('SECRET=value\n')
  })

  it('never adopts an exact checkout when creation crashes before its ownership marker', async () => {
    const fixture = await makeRepository()
    const request = {
      conversationId: 'conversation-before-marker',
      executionId: 'execution-before-marker',
      operationId: 'operation-before-marker',
      worktreeName: 'before-marker',
    } as const
    const manager = makeGitWorktreeManager({
      repository: fixture.sourceDirectory,
      testHooks: {
        afterWorktreeAdded: () =>
          Promise.reject(new Error('injected crash before marker')),
      },
    })

    const creation = await Effect.runPromise(
      Effect.result(manager.create(request))
    )
    expect(creation._tag).toBe('Failure')
    if (creation._tag !== 'Failure') {
      throw new Error('crash-before-marker creation unexpectedly succeeded')
    }
    expect(creation.failure).toBeInstanceOf(WorktreeProvisioningUncertain)
    const recoveryManager = makeGitWorktreeManager({
      repository: fixture.sourceDirectory,
    })
    if (recoveryManager.recover === undefined) {
      throw new Error('recover is unavailable')
    }
    expect(await effectFails(recoveryManager.recover(request))).toBe(true)
    const checkout = join(
      fixture.sandbox,
      'laborer.worktrees',
      request.worktreeName
    )
    expect(await git(checkout, ['branch', '--show-current'])).toBe(
      `laborer/${request.worktreeName}`
    )
    await expect(
      stat(join(checkout, '.laborer-worktree-owner.json'))
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('strictly rejects unsafe agent-supplied names without creating a worktree', async () => {
    const fixture = await makeRepository()
    const manager = makeGitWorktreeManager({
      repository: fixture.sourceDirectory,
    })
    const unsafeNames = [
      '../escape',
      'nested/name',
      'nested\\name',
      '.',
      'name..suffix',
      'branch.lock',
      '-option',
      'trailing-',
    ]

    for (const worktreeName of unsafeNames) {
      expect(
        await effectFails(
          manager.create({
            conversationId: 'conversation-invalid',
            executionId: `execution-${worktreeName}`,
            worktreeName,
          })
        )
      ).toBe(true)
    }

    await expect(
      stat(join(fixture.sandbox, 'laborer.worktrees'))
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects path, branch, and registered-worktree collisions without adopting them', async () => {
    const pathFixture = await makeRepository()
    const pathManager = makeGitWorktreeManager({
      repository: pathFixture.sourceDirectory,
    })
    const collidedPath = join(
      pathFixture.sandbox,
      'laborer.worktrees',
      'path-collision'
    )
    await mkdir(collidedPath, { recursive: true })
    await writeFile(join(collidedPath, 'sentinel'), 'untouched\n')
    expect(
      await effectFails(
        pathManager.create({
          conversationId: 'conversation-path',
          executionId: 'execution-path',
          worktreeName: 'path-collision',
        })
      )
    ).toBe(true)
    expect(await readFile(join(collidedPath, 'sentinel'), 'utf8')).toBe(
      'untouched\n'
    )
    expect(
      await git(pathFixture.repository, [
        'branch',
        '--list',
        'laborer/path-collision',
      ])
    ).toBe('')

    const branchFixture = await makeRepository()
    const branchManager = makeGitWorktreeManager({
      repository: branchFixture.sourceDirectory,
    })
    await git(branchFixture.repository, ['branch', 'laborer/branch-collision'])
    expect(
      await effectFails(
        branchManager.create({
          conversationId: 'conversation-branch',
          executionId: 'execution-branch',
          worktreeName: 'branch-collision',
        })
      )
    ).toBe(true)
    await expect(
      stat(join(branchFixture.sandbox, 'laborer.worktrees', 'branch-collision'))
    ).rejects.toMatchObject({ code: 'ENOENT' })

    const registeredFixture = await makeRepository()
    const registeredManager = makeGitWorktreeManager({
      repository: registeredFixture.sourceDirectory,
    })
    const registeredPath = join(
      registeredFixture.sandbox,
      'laborer.worktrees',
      'registered-collision'
    )
    await mkdir(dirname(registeredPath), { recursive: true })
    await git(registeredFixture.repository, [
      'worktree',
      'add',
      '-b',
      'foreign/registered-collision',
      registeredPath,
      'HEAD',
    ])
    expect(
      await effectFails(
        registeredManager.create({
          conversationId: 'conversation-registered',
          executionId: 'execution-registered',
          worktreeName: 'registered-collision',
        })
      )
    ).toBe(true)
    expect(await git(registeredPath, ['branch', '--show-current'])).toBe(
      'foreign/registered-collision'
    )
  })

  it('rejects an exact registered worktree without a Laborer ownership marker', async () => {
    const fixture = await makeRepository()
    const manager = makeGitWorktreeManager({
      repository: fixture.sourceDirectory,
    })
    const expectedPath = join(
      fixture.sandbox,
      'laborer.worktrees',
      'recover-existing'
    )
    await mkdir(dirname(expectedPath), { recursive: true })
    await git(fixture.repository, [
      'worktree',
      'add',
      '-b',
      'laborer/recover-existing',
      expectedPath,
      'HEAD',
    ])

    expect(manager.recover).toBeDefined()
    if (manager.recover === undefined) {
      throw new Error('recover is unavailable')
    }
    expect(
      await effectFails(
        manager.recover({
          conversationId: 'conversation-recover',
          executionId: 'execution-recover',
          worktreeName: 'recover-existing',
        })
      )
    ).toBe(true)
    expect(await git(expectedPath, ['branch', '--show-current'])).toBe(
      'laborer/recover-existing'
    )
    await expect(
      readFile(join(expectedPath, 'app', '.env.local'), 'utf8')
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('recovers an ambiguous staged request by creating only when path and branch are absent', async () => {
    const fixture = await makeRepository()
    const manager = makeGitWorktreeManager({
      repository: fixture.sourceDirectory,
    })
    if (manager.recover === undefined) {
      throw new Error('recover is unavailable')
    }

    const recovered = await Effect.runPromise(
      manager.recover({
        conversationId: 'conversation-create-on-recover',
        executionId: 'execution-create-on-recover',
        worktreeName: 'recover-new',
      })
    )

    const expectedPath = join(
      fixture.sandbox,
      'laborer.worktrees',
      'recover-new'
    )
    expect(recovered).toEqual({ workingDirectory: join(expectedPath, 'app') })
    expect(await git(expectedPath, ['branch', '--show-current'])).toBe(
      'laborer/recover-new'
    )
    expect(
      await readFile(join(expectedPath, 'app', '.env.local'), 'utf8')
    ).toBe('SECRET=value\n')
  })

  it('fails closed on partial or mismatched recovery state', async () => {
    const pathFixture = await makeRepository()
    const pathManager = makeGitWorktreeManager({
      repository: pathFixture.sourceDirectory,
    })
    if (pathManager.recover === undefined) {
      throw new Error('recover is unavailable')
    }
    const partialPath = join(
      pathFixture.sandbox,
      'laborer.worktrees',
      'recover-path-only'
    )
    await mkdir(partialPath, { recursive: true })
    await writeFile(join(partialPath, 'sentinel'), 'path-only\n')
    expect(
      await effectFails(
        pathManager.recover({
          conversationId: 'conversation-path-only',
          executionId: 'execution-path-only',
          worktreeName: 'recover-path-only',
        })
      )
    ).toBe(true)
    expect(await readFile(join(partialPath, 'sentinel'), 'utf8')).toBe(
      'path-only\n'
    )

    const branchFixture = await makeRepository()
    const branchManager = makeGitWorktreeManager({
      repository: branchFixture.sourceDirectory,
    })
    if (branchManager.recover === undefined) {
      throw new Error('recover is unavailable')
    }
    await git(branchFixture.repository, [
      'branch',
      'laborer/recover-branch-only',
    ])
    expect(
      await effectFails(
        branchManager.recover({
          conversationId: 'conversation-branch-only',
          executionId: 'execution-branch-only',
          worktreeName: 'recover-branch-only',
        })
      )
    ).toBe(true)
    await expect(
      stat(
        join(branchFixture.sandbox, 'laborer.worktrees', 'recover-branch-only')
      )
    ).rejects.toMatchObject({ code: 'ENOENT' })

    const mismatchFixture = await makeRepository()
    const mismatchManager = makeGitWorktreeManager({
      repository: mismatchFixture.sourceDirectory,
    })
    if (mismatchManager.recover === undefined) {
      throw new Error('recover is unavailable')
    }
    const expectedPath = join(
      mismatchFixture.sandbox,
      'laborer.worktrees',
      'recover-mismatch'
    )
    await mkdir(dirname(expectedPath), { recursive: true })
    await git(mismatchFixture.repository, [
      'worktree',
      'add',
      '-b',
      'foreign/recover-mismatch',
      expectedPath,
      'HEAD',
    ])
    expect(
      await effectFails(
        mismatchManager.recover({
          conversationId: 'conversation-mismatch',
          executionId: 'execution-mismatch',
          worktreeName: 'recover-mismatch',
        })
      )
    ).toBe(true)
    expect(await git(expectedPath, ['branch', '--show-current'])).toBe(
      'foreign/recover-mismatch'
    )
  })

  it('validates the exact persisted registration and never recreates it', async () => {
    const fixture = await makeRepository()
    const manager = makeGitWorktreeManager({
      repository: fixture.sourceDirectory,
    })
    const request = {
      conversationId: 'conversation-validate',
      executionId: 'execution-validate',
      worktreeName: 'validate-existing',
    } as const
    const worktree = await Effect.runPromise(manager.create(request))

    expect(manager.validate).toBeDefined()
    if (manager.validate === undefined) {
      throw new Error('validate is unavailable')
    }
    await Effect.runPromise(
      manager.validate({
        ...request,
        workingDirectory: worktree.workingDirectory,
      })
    )
    expect(
      await effectFails(
        manager.validate({
          ...request,
          workingDirectory: `${worktree.workingDirectory}/.`,
        })
      )
    ).toBe(true)
    expect((await stat(worktree.workingDirectory)).isDirectory()).toBe(true)

    await rm(worktree.workingDirectory, { recursive: true })
    expect(
      await effectFails(
        manager.validate({
          ...request,
          workingDirectory: worktree.workingDirectory,
        })
      )
    ).toBe(true)
    await expect(stat(worktree.workingDirectory)).rejects.toMatchObject({
      code: 'ENOENT',
    })
    expect(
      await git(fixture.repository, [
        'show-ref',
        '--verify',
        'refs/heads/laborer/validate-existing',
      ])
    ).toContain('refs/heads/laborer/validate-existing')
  })

  it('classifies exact and definitively missing persisted worktrees without mutation', async () => {
    const fixture = await makeRepository()
    const manager = makeGitWorktreeManager({
      repository: fixture.sourceDirectory,
    })
    const request = {
      conversationId: 'conversation-inspect',
      executionId: 'execution-inspect',
      operationId: 'operation-inspect',
      worktreeName: 'inspect-existing',
    } as const
    const created = await Effect.runPromise(manager.create(request))
    expect(manager.inspect).toBeDefined()
    if (manager.inspect === undefined) {
      throw new Error('inspect is unavailable')
    }
    const available = await Effect.runPromise(
      manager.inspect({
        ...request,
        creationState: 'confirmed',
        workingDirectory: created.workingDirectory,
      })
    )
    expect(available).toEqual({
      certainty: 'definitive',
      evidence: 'exact-owned-resource',
      resource: created,
      status: 'available',
    })

    const checkout = dirname(created.workingDirectory)
    await git(fixture.repository, ['worktree', 'remove', '--force', checkout])
    await git(fixture.repository, [
      'branch',
      '-D',
      `laborer/${request.worktreeName}`,
    ])
    const missing = await Effect.runPromise(
      manager.inspect({
        ...request,
        creationState: 'confirmed',
        workingDirectory: created.workingDirectory,
      })
    )
    expect(missing).toEqual({
      certainty: 'definitive',
      evidence: 'definitively-absent',
      status: 'missing',
    })
  })

  it('classifies an unmarked checkout as conflicting without repairing its environment', async () => {
    const fixture = await makeRepository()
    const manager = makeGitWorktreeManager({
      repository: fixture.sourceDirectory,
    })
    const request = {
      conversationId: 'conversation-unmarked-inspect',
      executionId: 'execution-unmarked-inspect',
      operationId: 'operation-unmarked-inspect',
      worktreeName: 'inspect-unmarked',
    } as const
    const checkout = join(
      fixture.sandbox,
      'laborer.worktrees',
      request.worktreeName
    )
    await mkdir(dirname(checkout), { recursive: true })
    await git(fixture.repository, [
      'worktree',
      'add',
      '-b',
      `laborer/${request.worktreeName}`,
      checkout,
      'HEAD',
    ])
    expect(manager.inspect).toBeDefined()
    if (manager.inspect === undefined) {
      throw new Error('inspect is unavailable')
    }
    const outcome = await Effect.runPromise(
      manager.inspect({
        ...request,
        creationState: 'confirmed',
        workingDirectory: join(checkout, 'app'),
      })
    )
    expect(outcome).toEqual({
      certainty: 'definitive',
      evidence: 'identity-conflict',
      status: 'conflicting',
    })
    await expect(
      readFile(join(checkout, 'app', '.env.local'), 'utf8')
    ).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('refuses to follow a source .env.local symlink', async () => {
    const fixture = await makeRepository()
    const sourceEnvironment = join(fixture.sourceDirectory, '.env.local')
    const outsideSecret = join(fixture.sandbox, 'outside-secret')
    await unlink(sourceEnvironment)
    await writeFile(outsideSecret, 'MUST_NOT_COPY=value\n', { mode: 0o600 })
    await symlink(outsideSecret, sourceEnvironment)
    const manager = makeGitWorktreeManager({
      repository: fixture.sourceDirectory,
    })

    expect(
      await effectFails(
        manager.create({
          conversationId: 'conversation-symlink',
          executionId: 'execution-symlink',
          worktreeName: 'unsafe-environment',
        })
      )
    ).toBe(true)
    await expect(
      stat(join(fixture.sandbox, 'laborer.worktrees', 'unsafe-environment'))
    ).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(outsideSecret, 'utf8')).toBe('MUST_NOT_COPY=value\n')
  })
})
