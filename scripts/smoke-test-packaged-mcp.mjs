#!/usr/bin/env node

import { spawn } from 'node:child_process'

const [command, ...args] = process.argv.slice(2)
if (!command) {
  throw new Error('Usage: smoke-test-packaged-mcp.mjs <command> [args...]')
}

const child = spawn(command, args, {
  env: process.env,
  stdio: ['pipe', 'pipe', 'pipe'],
})
child.stdout.setEncoding('utf8')
child.stderr.setEncoding('utf8')

let buffer = ''
let stderr = ''
let nextId = 0
const pending = new Map()

child.stderr.on('data', (chunk) => {
  stderr += chunk
})
child.stdout.on('data', (chunk) => {
  buffer += chunk
  const lines = buffer.split('\n')
  buffer = lines.pop() ?? ''
  for (const line of lines) {
    if (!line) {
      continue
    }
    let message
    try {
      message = JSON.parse(line)
    } catch {
      throw new Error(`MCP stdout contained a non-protocol line: ${line}`)
    }
    pending.get(message.id)?.(message)
    pending.delete(message.id)
  }
})

const request = (method, params = {}) => {
  nextId += 1
  const id = nextId
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`Timed out waiting for ${method}; stderr: ${stderr}`))
    }, 10_000)
    pending.set(id, (message) => {
      clearTimeout(timeout)
      resolve(message)
    })
    child.stdin.write(
      `${JSON.stringify({ id, jsonrpc: '2.0', method, params })}\n`
    )
  })
}

try {
  const initialized = await request('initialize', {
    capabilities: {},
    clientInfo: { name: 'packaged-app-smoke', version: '1.0.0' },
    protocolVersion: '2025-06-18',
  })
  if (initialized.error) {
    throw new Error(
      `MCP initialize failed: ${JSON.stringify(initialized.error)}`
    )
  }
  child.stdin.write(
    `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`
  )
  const called = await request('tools/call', {
    arguments: {},
    name: 'list_projects',
  })
  if (
    called.error ||
    !Array.isArray(called.result?.structuredContent?.projects)
  ) {
    throw new Error(`MCP tool call failed: ${JSON.stringify(called)}`)
  }
} finally {
  child.kill('SIGTERM')
}
