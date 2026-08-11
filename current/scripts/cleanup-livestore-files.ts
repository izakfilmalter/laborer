#!/usr/bin/env tsx

import { parseArgs } from 'node:util'
import {
  cleanupLiveStoreTargets,
  enumerateLiveStoreCleanupTargets,
} from '../apps/desktop/src/livestore-cleanup.js'

const { values } = parseArgs({
  options: {
    delete: { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
  },
  strict: true,
})

if (values.delete && values['dry-run']) {
  throw new Error('Choose either --dry-run or --delete, not both')
}

const deleteFiles = values.delete === true
const results = cleanupLiveStoreTargets(enumerateLiveStoreCleanupTargets(), {
  deleteFiles,
})

console.info(
  deleteFiles
    ? 'Deleting obsolete LiveStore files (Laborer must be closed):'
    : 'Dry run only; no files will be deleted:'
)

for (const result of results) {
  let action = 'not found'
  if (result.existed) {
    action = deleteFiles ? 'deleted' : 'would delete'
  }
  console.info(`  [${action}] ${result.path} (${result.kind})`)
}

if (!deleteFiles) {
  console.info('\nRun again with --delete to remove the listed files.')
}
