import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { extname, relative } from 'node:path'
import { assert, describe, it } from '@effect/vitest'

const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as {
  readonly dependencies?: Readonly<Record<string, string>>
  readonly devDependencies?: Readonly<Record<string, string>>
  readonly optionalDependencies?: Readonly<Record<string, string>>
  readonly peerDependencies?: Readonly<Record<string, string>>
  readonly scripts?: Readonly<Record<string, string>>
  readonly trustedDependencies?: readonly string[]
}

const operationalExtensions = new Set([
  '.cjs',
  '.js',
  '.mjs',
  '.sh',
  '.ts',
  '.tsx',
])
const v1PackageOrInstallSource =
  /(?:^|[^@A-Za-z0-9_-])opencode-ai(?=@|[\s"'\\]|$)|https?:\/\/opencode\.ai\/install\b/
const bareOpenCodeRun =
  /(?:^|[;&|$(=:[{,]|\b(?:command|exec|return)\s+|["'`])\s*opencode["']?\s+run\b/m
const programmaticOpenCodeRun =
  /\b(?:execFile|execFileSync|spawn|spawnSync)\s*\(\s*["'`]opencode["'`]\s*,\s*\[\s*["'`]run["'`]/m
const managedOpenCode2Invocation = /"--",\s*"opencode2"/

const operationalSourcePaths = (): readonly string[] =>
  execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '.'],
    {
      encoding: 'utf8',
    }
  )
    .split('\0')
    .filter(
      (path) =>
        path.length > 0 &&
        existsSync(path) &&
        (path.endsWith('Dockerfile') ||
          operationalExtensions.has(extname(path)))
    )
    .sort()

const violationsIn = (path: string, source: string): readonly string[] => {
  if (path === 'package.json') {
    return bareOpenCodeRun.test(source) || programmaticOpenCodeRun.test(source)
      ? ['bare opencode run']
      : []
  }
  if (path.startsWith('docs/') || path.startsWith('tests/')) {
    return []
  }
  return [
    ...(v1PackageOrInstallSource.test(source)
      ? ['OpenCode V1 package or install source']
      : []),
    ...(bareOpenCodeRun.test(source) || programmaticOpenCodeRun.test(source)
      ? ['bare opencode run']
      : []),
  ]
}

describe('OpenCode V1 operational source policy', () => {
  it('recognizes V1 install sources and effective bare launches', () => {
    assert.deepStrictEqual(
      violationsIn(
        '.sandcastle/Dockerfile',
        'RUN npm install -g opencode-ai@1.18.4'
      ),
      ['OpenCode V1 package or install source']
    )
    assert.deepStrictEqual(
      violationsIn(
        '.sandcastle/install.sh',
        'curl -fsSL https://opencode.ai/install | bash'
      ),
      ['OpenCode V1 package or install source']
    )
    assert.deepStrictEqual(
      violationsIn('src/launcher.sh', 'exec "opencode" run --format json'),
      ['bare opencode run']
    )
    assert.deepStrictEqual(
      violationsIn(
        'src/launcher.ts',
        'spawn("opencode", ["run", "--format", "json"])'
      ),
      ['bare opencode run']
    )
  })

  it('keeps the V1 package and bare launcher out of operational next sources', () => {
    const dependencyGroups = [
      packageJson.dependencies,
      packageJson.devDependencies,
      packageJson.optionalDependencies,
      packageJson.peerDependencies,
    ]
    for (const dependencies of dependencyGroups) {
      assert.notProperty(dependencies ?? {}, 'opencode-ai')
    }
    assert.notInclude(packageJson.trustedDependencies ?? [], 'opencode-ai')

    const sources = operationalSourcePaths().map((path) => ({
      path: relative('.', path),
      source: readFileSync(path, 'utf8'),
    }))
    for (const [name, script] of Object.entries(packageJson.scripts ?? {})) {
      sources.push({ path: `package.json#scripts.${name}`, source: script })
    }

    const violations = sources.flatMap(({ path, source }) =>
      violationsIn(path, source).map((violation) => `${path}: ${violation}`)
    )
    assert.deepStrictEqual(violations, [])
  })

  it('leaves the Sandcastle opencode2 version and configuration machine-managed', () => {
    const sandcastlePackage = JSON.parse(
      readFileSync('../../.sandcastle/package.json', 'utf8')
    ) as {
      readonly devDependencies?: Readonly<Record<string, string>>
    }
    const agent = readFileSync(
      '../../.sandcastle/opencode2-agent/index.ts',
      'utf8'
    )
    assert.notProperty(
      sandcastlePackage.devDependencies ?? {},
      '@opencode-ai/cli'
    )
    assert.match(agent, managedOpenCode2Invocation)
    assert.notInclude(agent, 'OPENCODE_DB')
  })

  it('permits intentional V2 and compatibility vocabulary', () => {
    const allowedOperationalSource = [
      'import "@opencode-ai/cli";',
      'const executable = "opencode2";',
      'const config = ".config/opencode";',
      'const authorization = `Basic $' +
        '{Buffer.from(`opencode:$' +
        '{password}`)}`;',
      'const model = { providerID: "opencode" };',
      'basename(options.command) === "opencode";',
    ].join('\n')
    const historicalDocumentation = [
      'npm install -g opencode-ai@1.18.4',
      'opencode run --format json',
    ].join('\n')

    assert.deepStrictEqual(
      violationsIn('src/adapter.ts', allowedOperationalSource),
      []
    )
    assert.deepStrictEqual(
      violationsIn('docs/history.md', historicalDocumentation),
      []
    )
  })
})
