import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, assert, describe, it } from '@effect/vitest'
import {
  isSupportedOpenCodeVersion,
  OPEN_CODE_COMMAND_VARIABLE,
  resolveInstalledOpenCode,
} from '../src/acp-runtime/installed-opencode.ts'

const MISSING_OPENCODE_MESSAGE =
  /OpenCode 2 was not found on PATH\..*1\.18\.23.*LABORER_OPENCODE_COMMAND/

const roots: string[] = []

const fakeOpenCode = (name: string, versionOutput: string): string => {
  const directory = mkdtempSync(join(tmpdir(), 'laborer-installed-opencode-'))
  roots.push(directory)
  mkdirSync(directory, { recursive: true })
  const command = join(directory, name)
  writeFileSync(command, `#!/bin/sh\necho '${versionOutput}'\n`)
  chmodSync(command, 0o755)
  return directory
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true })
  }
})

describe('installed OpenCode resolution', () => {
  it('accepts OpenCode 2 releases and preview builds only', () => {
    assert.isTrue(isSupportedOpenCodeVersion('2.0.16'))
    assert.isTrue(isSupportedOpenCodeVersion('3.1.0'))
    assert.isTrue(isSupportedOpenCodeVersion('0.0.0-next-17074'))
    assert.isFalse(isSupportedOpenCodeVersion('1.18.23'))
    assert.isFalse(isSupportedOpenCodeVersion('0.15.2'))
    assert.isFalse(isSupportedOpenCodeVersion('latest'))
  })

  it('skips an OpenCode 1 earlier on PATH and uses the installed OpenCode 2', () => {
    const legacy = fakeOpenCode('opencode', '1.18.23')
    const current = fakeOpenCode('opencode', 'opencode v2.0.16')
    const installed = resolveInstalledOpenCode({
      PATH: [legacy, current].join(delimiter),
    })
    assert.deepStrictEqual(installed, {
      command: join(current, 'opencode'),
      version: '2.0.16',
    })
  })

  it('ignores project node_modules binaries that package runners put on PATH', () => {
    const project = fakeOpenCode('placeholder', '')
    const bundledBin = join(project, 'node_modules', '.bin')
    mkdirSync(bundledBin, { recursive: true })
    writeFileSync(
      join(bundledBin, 'opencode2'),
      "#!/bin/sh\necho 'opencode2 v0.0.0-next-17074'\n"
    )
    chmodSync(join(bundledBin, 'opencode2'), 0o755)
    const machine = fakeOpenCode('opencode', 'opencode v2.0.16')
    assert.strictEqual(
      resolveInstalledOpenCode({ PATH: [bundledBin, machine].join(delimiter) })
        .command,
      join(machine, 'opencode')
    )
  })

  it('finds an opencode2 executable', () => {
    const directory = fakeOpenCode('opencode2', 'opencode2 v0.0.0-beta-19271')
    assert.strictEqual(
      resolveInstalledOpenCode({ PATH: directory }).version,
      '0.0.0-beta-19271'
    )
  })

  it('prefers an explicit command over PATH', () => {
    const onPath = fakeOpenCode('opencode', 'opencode v2.0.16')
    const explicit = fakeOpenCode('custom-opencode', 'opencode v2.1.0')
    const installed = resolveInstalledOpenCode({
      [OPEN_CODE_COMMAND_VARIABLE]: join(explicit, 'custom-opencode'),
      PATH: onPath,
    })
    assert.strictEqual(installed.version, '2.1.0')
  })

  it('explains when no OpenCode 2 is installed', () => {
    const legacy = fakeOpenCode('opencode', '1.18.23')
    assert.throws(
      () => resolveInstalledOpenCode({ PATH: legacy }),
      MISSING_OPENCODE_MESSAGE
    )
  })
})
