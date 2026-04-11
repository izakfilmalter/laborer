import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const testStateDirectory = fileURLToPath(
  new URL('./.playwright/server-state', import.meta.url)
)

export default async function globalSetup() {
  await rm(testStateDirectory, { force: true, recursive: true })
  await mkdir(path.dirname(testStateDirectory), { recursive: true })
}
