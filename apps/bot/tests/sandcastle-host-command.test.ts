import { spawn } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import { assert, describe, it } from '@effect/vitest'
import {
  boundedHostCommand,
  supervisedNoSandbox,
} from '../../../.sandcastle/host-native-provider/index.ts'

describe('Sandcastle host process supervision', () => {
  it('isolates concurrent global Git configuration writes', async () => {
    const firstDirectory = mkdtempSync(join(tmpdir(), 'laborer-host-git-a-'))
    const secondDirectory = mkdtempSync(join(tmpdir(), 'laborer-host-git-b-'))
    const provider = supervisedNoSandbox({ defaultTimeoutSeconds: 30 })
    const [first, second] = await Promise.all([
      provider.create({ env: {}, worktreePath: firstDirectory }),
      provider.create({ env: {}, worktreePath: secondDirectory }),
    ])

    try {
      const [firstWrite, secondWrite] = await Promise.all([
        first.exec(
          `git config --global --add safe.directory ${JSON.stringify(firstDirectory)} && printf '%s' "$GIT_CONFIG_GLOBAL"`
        ),
        second.exec(
          `git config --global --add safe.directory ${JSON.stringify(secondDirectory)} && printf '%s' "$GIT_CONFIG_GLOBAL"`
        ),
      ])

      assert.strictEqual(firstWrite.exitCode, 0)
      assert.strictEqual(secondWrite.exitCode, 0)
      assert.notStrictEqual(firstWrite.stdout, secondWrite.stdout)
      assert.strictEqual(
        readFileSync(firstWrite.stdout, 'utf8').includes(firstDirectory),
        true
      )
      assert.strictEqual(
        readFileSync(secondWrite.stdout, 'utf8').includes(secondDirectory),
        true
      )
    } finally {
      await Promise.all([first.close(), second.close()])
      rmSync(firstDirectory, { force: true, recursive: true })
      rmSync(secondDirectory, { force: true, recursive: true })
    }
  })

  it('times out and kills the complete command process group', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'laborer-host-command-'))
    const childPidPath = join(directory, 'child-pid')
    const provider = supervisedNoSandbox({
      defaultTimeoutSeconds: 30,
      killGraceMilliseconds: 100,
    })
    const handle = await provider.create({ env: {}, worktreePath: directory })

    try {
      const result = await handle.exec(
        boundedHostCommand(
          `trap '' TERM; sleep 30 & echo $! > '${childPidPath}'; wait`,
          0.2
        )
      )

      assert.strictEqual(result.exitCode, 124)
      assert.isTrue(existsSync(childPidPath))
      assertProcessDoesNotExist(childPidPath)
    } finally {
      await handle.close()
      rmSync(directory, { force: true, recursive: true })
    }
  })

  it('reaps descendants left behind by a successful command', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'laborer-host-descendant-'))
    const childPidPath = join(directory, 'child-pid')
    const provider = supervisedNoSandbox({
      defaultTimeoutSeconds: 30,
      killGraceMilliseconds: 100,
    })
    const handle = await provider.create({ env: {}, worktreePath: directory })

    try {
      const result = await handle.exec(`sleep 30 & echo $! > '${childPidPath}'`)

      assert.strictEqual(result.exitCode, 0)
      assertProcessDoesNotExist(childPidPath)
    } finally {
      await handle.close()
      rmSync(directory, { force: true, recursive: true })
    }
  })

  it('kills an active command when the provider closes', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'laborer-host-close-'))
    const childPidPath = join(directory, 'child-pid')
    const provider = supervisedNoSandbox({
      defaultTimeoutSeconds: 30,
      killGraceMilliseconds: 100,
    })
    const handle = await provider.create({ env: {}, worktreePath: directory })

    try {
      const pending = handle.exec(
        `trap '' TERM; echo $$ > '${childPidPath}'; sleep 30`
      )
      for (
        let attempt = 0;
        attempt < 100 && !existsSync(childPidPath);
        attempt++
      ) {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      assert.isTrue(existsSync(childPidPath))

      await handle.close()
      const result = await pending

      assert.notStrictEqual(result.exitCode, 0)
      assertProcessDoesNotExist(childPidPath)
    } finally {
      await handle.close()
      rmSync(directory, { force: true, recursive: true })
    }
  })

  it('finishes teardown when the process group id has been recycled away', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'laborer-host-foreign-'))
    const provider = supervisedNoSandbox({
      defaultTimeoutSeconds: 30,
      killGraceMilliseconds: 100,
    })
    const handle = await provider.create({ env: {}, worktreePath: directory })
    const realKill = process.kill.bind(process)
    // Once our child exits the kernel may hand its group id to a process we do
    // not own, so signalling the group reports EPERM rather than ESRCH.
    process.kill = ((pid: number, signal?: string | number) => {
      if (pid < 0) {
        throw Object.assign(new Error('kill EPERM'), {
          code: 'EPERM',
          errno: -1,
          syscall: 'kill',
        })
      }
      return realKill(pid, signal as NodeJS.Signals)
    }) as typeof process.kill

    try {
      const result = await handle.exec("printf 'done'")

      assert.strictEqual(result.exitCode, 0)
      assert.strictEqual(result.stdout, 'done')
      await handle.close()
    } finally {
      process.kill = realKill
      rmSync(directory, { force: true, recursive: true })
    }
  })

  it('bounds retained and partial-line output', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'laborer-host-output-'))
    const provider = supervisedNoSandbox({
      defaultTimeoutSeconds: 30,
      maxOutputTailChars: 32,
    })
    const handle = await provider.create({ env: {}, worktreePath: directory })
    const lines: string[] = []

    try {
      const result = await handle.exec("printf '%01000d' 0", {
        onLine: (line) => lines.push(line),
      })

      assert.strictEqual(result.exitCode, 0)
      assert.isAtMost(result.stdout.length, 32)
      assert.deepStrictEqual(lines, ['0'.repeat(32)])
    } finally {
      await handle.close()
      rmSync(directory, { force: true, recursive: true })
    }
  })

  it('kills active descendants when the runner receives SIGINT', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'laborer-host-signal-'))
    const childPidPath = join(directory, 'child-pid')
    const scriptPath = join(directory, 'runner.ts')
    const providerPath = resolve(
      '../../.sandcastle/host-native-provider/index.ts'
    )
    writeFileSync(
      scriptPath,
      [
        `import { supervisedNoSandbox } from ${JSON.stringify(providerPath)};`,
        `const handle = await supervisedNoSandbox({ defaultTimeoutSeconds: 30 }).create({ env: {}, worktreePath: ${JSON.stringify(directory)} });`,
        `await handle.exec(${JSON.stringify(`trap '' TERM; echo $$ > '${childPidPath}'; sleep 30`)});`,
      ].join('\n')
    )

    try {
      const runner = spawn('bun', [scriptPath], { stdio: 'ignore' })
      for (
        let attempt = 0;
        attempt < 200 && !existsSync(childPidPath);
        attempt++
      ) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 10))
      }
      assert.isTrue(existsSync(childPidPath))

      const closed = new Promise<number | null>((resolvePromise) => {
        runner.on('close', resolvePromise)
      })
      runner.kill('SIGINT')
      const exitCode = await closed

      assert.strictEqual(exitCode, 130)
      assertProcessDoesNotExist(childPidPath)
    } finally {
      rmSync(directory, { force: true, recursive: true })
    }
  })

  it('reports an interactive spawn failure without crashing the runner', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'laborer-host-spawn-'))
    const handle = await supervisedNoSandbox({
      defaultTimeoutSeconds: 30,
    }).create({ env: {}, worktreePath: directory })
    const stream = new PassThrough()

    try {
      let failed = false
      try {
        await handle.interactiveExec(['definitely-not-a-real-executable'], {
          stderr: stream,
          stdin: stream,
          stdout: stream,
        })
      } catch {
        failed = true
      }
      assert.isTrue(failed)
    } finally {
      await handle.close()
      stream.destroy()
      rmSync(directory, { force: true, recursive: true })
    }
  })
})

const assertProcessDoesNotExist = (pidPath: string) => {
  const childPid = Number(readFileSync(pidPath, 'utf8').trim())
  assert.throws(() => process.kill(childPid, 0))
}
