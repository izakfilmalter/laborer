import { readFile } from 'node:fs/promises'

const packageSource = await readFile(
  new URL('../../package.json', import.meta.url),
  'utf8'
)
const packageJson = JSON.parse(packageSource) as {
  readonly packageManager?: string
}
const packageManager = packageJson.packageManager
if (packageManager === undefined || !packageManager.startsWith('bun@')) {
  throw new Error('package.json must declare an exact bun@ version')
}
const expectedBun = packageManager.slice('bun@'.length)
const actualBun = process.versions.bun
if (actualBun !== undefined) {
  if (actualBun !== expectedBun) {
    throw new Error(
      `Unsupported Bun runtime: expected ${expectedBun}, received ${actualBun}`
    )
  }
} else {
  const expectedNode = (
    await readFile(new URL('../../.node-version', import.meta.url), 'utf8')
  ).trim()
  if (process.versions.node !== expectedNode) {
    throw new Error(
      `Unsupported Node runtime: expected ${expectedNode}, received ${process.versions.node}`
    )
  }
}
