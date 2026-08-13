#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { closeSync, writeSync } from 'node:fs'

const command = process.argv[2]
const args = process.argv.slice(3)

const report = (result: {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
  readonly spawnFailed: boolean
}): void => {
  if (reported) {
    return
  }
  reported = true
  writeSync(3, `${JSON.stringify(result)}\n`)
}

let reported = false

// Laborer owns this detached group only while this leader remains alive. TERM
// deliberately leaves the sentinel in place so the parent can safely inspect
// and, if needed, KILL remaining group members without a numeric-PGID reuse
// window.
process.on('SIGTERM', () => undefined)
process.on('SIGINT', () => undefined)

if (command === undefined || command.length === 0) {
  report({ code: null, signal: null, spawnFailed: true })
} else {
  const handler = spawn(command, args, {
    cwd: process.cwd(),
    env: process.env,
    shell: false,
    stdio: ['inherit', 'inherit', 'inherit'],
  })
  closeSync(0)
  closeSync(1)
  closeSync(2)
  handler.once('error', () => {
    report({ code: null, signal: null, spawnFailed: true })
  })
  handler.once('exit', (code, signal) => {
    report({ code, signal, spawnFailed: false })
  })
}

setInterval(() => undefined, 60_000)
