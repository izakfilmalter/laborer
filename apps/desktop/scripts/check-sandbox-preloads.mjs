import NodeEvents from 'node:events'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import NodeTimers from 'node:timers'
import NodeURL from 'node:url'
import { runInNewContext } from 'node:vm'
import { parse } from 'acorn'

const outputDirectory = join(import.meta.dirname, '..', 'dist-electron')
const preloadFiles = [
  'preload.cjs',
  'preview-pick-preload.cjs',
  'preview-pip-preload.cjs',
]

function isSyntaxNode(value) {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    typeof value.type === 'string'
  )
}

function inspectBundle(source) {
  const runtimeImports = []
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: recursive AST validation keeps every require/import form in one auditable walk.
  const visit = (node) => {
    if (node.type === 'ImportExpression') {
      throw new Error('Sandboxed preload contains a dynamic import() call')
    }

    if (
      node.type === 'CallExpression' &&
      node.callee.type === 'Identifier' &&
      node.callee.name === 'require'
    ) {
      const [argument] = node.arguments
      if (
        node.arguments.length !== 1 ||
        argument?.type !== 'Literal' ||
        typeof argument.value !== 'string'
      ) {
        throw new Error('Sandboxed preload contains a dynamic require() call')
      }
      runtimeImports.push(argument.value)
    }

    for (const child of Object.values(node)) {
      if (Array.isArray(child)) {
        for (const item of child) {
          if (isSyntaxNode(item)) {
            visit(item)
          }
        }
      } else if (isSyntaxNode(child)) {
        visit(child)
      }
    }
  }

  visit(parse(source, { ecmaVersion: 'latest', sourceType: 'script' }))
  return runtimeImports
}

function createSandboxModules(exposedGlobals) {
  const ipcRenderer = {
    invoke: () => Promise.resolve(undefined),
    on: () => undefined,
    removeListener: () => undefined,
    send: () => undefined,
    sendSync: () => undefined,
  }
  const electron = {
    contextBridge: {
      exposeInMainWorld: (name, api) => exposedGlobals.set(name, api),
    },
    ipcRenderer,
  }

  return new Map([
    ['electron', electron],
    ['electron/common', electron],
    ['electron/renderer', electron],
    ['events', NodeEvents],
    ['node:events', NodeEvents],
    ['timers', NodeTimers],
    ['node:timers', NodeTimers],
    ['url', NodeURL],
    ['node:url', NodeURL],
  ])
}

function verifyMainPreloadExecution(source, sandboxModules, exposedGlobals) {
  runInNewContext(
    source,
    {
      process: {
        argv: ['electron', 'app', '--laborer-window-id=preload-smoke-window'],
        contextIsolated: true,
      },
      require: (moduleName) => {
        if (!sandboxModules.has(moduleName)) {
          throw new Error(
            `Unsupported sandbox module requested during preload execution: ${moduleName}`
          )
        }
        return sandboxModules.get(moduleName)
      },
    },
    { filename: 'preload.cjs', timeout: 1000 }
  )

  const desktopBridge = exposedGlobals.get('desktopBridge')
  const missingApis = ['getWindowId', 'pickFolder'].filter(
    (api) => typeof desktopBridge?.[api] !== 'function'
  )
  if (!desktopBridge || typeof desktopBridge.preview !== 'object') {
    missingApis.push('desktopBridge.preview')
  }
  if (missingApis.length > 0) {
    throw new Error(
      `Sandboxed preload is missing executable APIs: ${missingApis.join(', ')}`
    )
  }
}

const failures = []
let mainPreload

for (const file of preloadFiles) {
  try {
    const outputPath = join(outputDirectory, file)
    const output = readFileSync(outputPath, 'utf8')
    const exposedGlobals = new Map()
    const sandboxModules = createSandboxModules(exposedGlobals)
    const unsupportedImports = [...new Set(inspectBundle(output))]
      .filter((moduleName) => !sandboxModules.has(moduleName))
      .toSorted()

    if (unsupportedImports.length > 0) {
      throw new Error(
        `contains unsupported sandbox imports: ${unsupportedImports.join(', ')}`
      )
    }

    const sourceMap = JSON.parse(readFileSync(`${outputPath}.map`, 'utf8'))
    const runtimeDependencies = sourceMap.sources.filter(
      (source) => !source.startsWith('../src/')
    )
    if (runtimeDependencies.length > 0) {
      throw new Error(
        `bundles runtime dependencies: ${runtimeDependencies.join(', ')}`
      )
    }

    if (file === 'preload.cjs') {
      mainPreload = { exposedGlobals, output, sandboxModules }
    }
  } catch (error) {
    failures.push(`${file}: ${error instanceof Error ? error.message : error}`)
  }
}

if (mainPreload) {
  try {
    verifyMainPreloadExecution(
      mainPreload.output,
      mainPreload.sandboxModules,
      mainPreload.exposedGlobals
    )
  } catch (error) {
    failures.push(
      `preload.cjs: ${error instanceof Error ? error.message : error}`
    )
  }
}

if (failures.length > 0) {
  throw new Error(
    `Sandboxed Electron preload verification failed:\n${failures
      .map((failure) => `- ${failure}`)
      .join('\n')}`
  )
}

console.log('Validated sandboxed Electron preload bundles')
