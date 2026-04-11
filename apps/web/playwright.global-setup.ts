import { execFile } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const testStateDirectory = fileURLToPath(
  new URL('./.playwright/server-state', import.meta.url)
)

export default async function globalSetup() {
  await rm(testStateDirectory, { force: true, recursive: true })
  await mkdir(testStateDirectory, { recursive: true })

  const repoRoot = path.join(testStateDirectory, 'repos', 'workspace-fixture')
  await mkdir(repoRoot, { recursive: true })
  await writeFile(path.join(repoRoot, 'README.md'), '# Workspace fixture\n')

  await runGit(['init', '--initial-branch=main'], repoRoot)
  await runGit(['add', 'README.md'], repoRoot)
  await runGit(['commit', '-m', 'Initial commit'], repoRoot)
}

const runGit = async (args: readonly string[], cwd: string) => {
  await new Promise<void>((resolve, reject) => {
    const child = execFile('git', args, {
      cwd,
      env: {
        ...process.env,
        GIT_AUTHOR_EMAIL: 'laborer-tests@example.com',
        GIT_AUTHOR_NAME: 'Laborer Tests',
        GIT_COMMITTER_EMAIL: 'laborer-tests@example.com',
        GIT_COMMITTER_NAME: 'Laborer Tests',
      },
    })

    let stderr = ''
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) {
        resolve()
        return
      }

      reject(
        new Error(
          stderr.trim().length > 0
            ? stderr.trim()
            : `git ${args.join(' ')} failed with exit code ${code ?? 'unknown'}`
        )
      )
    })
  })
}
