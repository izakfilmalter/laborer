import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Repository root derived from an ACP runtime source module under apps/bot/src. */
export const repositoryRootFromAcpRuntimeModule = (moduleUrl: string): string =>
  dirname(fileURLToPath(new URL('../../../../package.json', moduleUrl)))
