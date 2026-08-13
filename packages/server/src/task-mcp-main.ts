#!/usr/bin/env node

import { unsupportedMcpNodeMessage } from './mcp-node-version.js'

const unsupportedMessage = unsupportedMcpNodeMessage(process.version)

if (unsupportedMessage !== undefined) {
  process.stderr.write(`${unsupportedMessage}\n`)
  process.exitCode = 1
} else {
  const runtimeFile = import.meta.url.endsWith('.ts')
    ? './task-mcp-runtime.ts'
    : './task-mcp-runtime.mjs'
  await import(new URL(runtimeFile, import.meta.url).href)
}
