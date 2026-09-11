#!/usr/bin/env bun

import { spawn } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

const MAX_SAMPLES = 2000
const require = createRequire(import.meta.url)

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : process.argv[index + 1]
}

function boundedInteger(name, fallback, minimum, maximum) {
  const value = Number(argument(name, String(fallback)))
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(
      `--${name} must be an integer from ${minimum} to ${maximum}`
    )
  }
  return value
}

const port = boundedInteger('port', 4179, 1, 65_535)
const count = boundedInteger('count', 5, 1, 100)
const delay = boundedInteger('delay', 8, 0, 1000)
const output = argument(
  'output',
  `terminal-latency-report-${new Date().toISOString().replaceAll(':', '-')}.json`
)
const base = argument('sequence', 'abcdefghijklmnopqrstuvwxyz0123456789')
const rpcUrl = argument('rpc-url', undefined)
const terminalId = argument('terminal-id', undefined)
const command = argument('command', undefined)
const browserChannel = argument('browser-channel', 'chromium')
const renderOutput = argument('render-output', 'immediate')
if (!['chromium', 'chrome'].includes(browserChannel)) {
  throw new Error('--browser-channel must be chromium or chrome')
}
if (!['frame', 'immediate'].includes(renderOutput)) {
  throw new Error('--render-output must be frame or immediate')
}
if (base.length === 0) {
  throw new Error('--sequence must not be empty')
}
const sequence = base.repeat(count)
if (Array.from(sequence).length > MAX_SAMPLES) {
  throw new Error(`Requested sequence exceeds the ${MAX_SAMPLES} sample cap`)
}
if (terminalId !== undefined && rpcUrl === undefined) {
  throw new Error('--terminal-id requires --rpc-url')
}
if (command !== undefined && rpcUrl === undefined) {
  throw new Error('--command requires --rpc-url')
}

const url = `http://127.0.0.1:${String(port)}`
const pageUrl = new URL(url)
pageUrl.searchParams.set('renderOutput', renderOutput)
if (rpcUrl !== undefined) {
  pageUrl.searchParams.set('rpcUrl', rpcUrl)
  if (terminalId !== undefined) {
    pageUrl.searchParams.set('terminalId', terminalId)
  }
  if (command !== undefined) {
    pageUrl.searchParams.set('command', command)
  }
}

async function waitForServer() {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      if (response.ok) {
        return
      }
    } catch {
      // Vite is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Diagnostic Vite server did not start at ${url}`)
}

function lifecyclePassed(report) {
  return report.lifecycleCases.every(
    (item) =>
      item.canvasOperationsWhileSuppressed === 0 &&
      item.contentPreserved &&
      item.markerVisibleAfterRestore &&
      !item.markerVisibleWhileSuppressed &&
      item.renderResumed
  )
}

function rpcPassed(report) {
  const outputVerified =
    report.rpc?.verificationMode === 'tui-viewport'
      ? report.rpc.renderedPromptVerified
      : report.rpc?.outputExact === true
  return (
    report.rpc?.error === null &&
    report.rpc.measurementCapped === false &&
    outputVerified &&
    report.rpc.writes.every(
      (write) =>
        write.error === undefined &&
        write.sentAt !== undefined &&
        write.returnedAt !== undefined &&
        write.outputAt !== undefined
    ) &&
    report.rpc.acknowledgements.every(
      (ack) => ack.error === undefined && ack.returnedAt !== undefined
    )
  )
}

const webDirectory = fileURLToPath(new URL('..', import.meta.url))
const vitePackage = require.resolve('vite/package.json')
const viteEntry = join(dirname(vitePackage), 'bin/vite.js')
const server = spawn(
  process.execPath,
  [viteEntry, '--config', 'diagnostics/vite.config.ts'],
  {
    cwd: webDirectory,
    env: { ...process.env, DIAGNOSTIC_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  }
)

let serverError = ''
server.stderr.on('data', (chunk) => {
  serverError += String(chunk)
})

let browser
let page
try {
  await waitForServer()
  browser = await chromium.launch({
    headless: true,
    ...(browserChannel === 'chrome' ? { channel: 'chrome' } : {}),
  })
  page = await browser.newPage({ viewport: { width: 1200, height: 900 } })
  await page.goto(pageUrl.href)
  await page.locator('body[data-ready="true"]').waitFor()
  if (rpcUrl !== undefined) {
    await page.locator('body[data-rpc-ready="true"]').waitFor()
  }
  await page.evaluate((expected) => {
    window.terminalLatencyDiagnostic?.startExternalRun(expected)
  }, sequence)
  await page.keyboard.type(sequence, { delay })
  const baseline = await page.evaluate(async () => {
    return await window.terminalLatencyDiagnostic?.finishExternalRun()
  })
  if (!baseline) {
    throw new Error('The diagnostic page did not return a report')
  }

  let report
  let passed = baseline.sequence.exactMatch
  if (rpcUrl === undefined) {
    const marker = 'SCROLL_ECHO_42'
    await page.evaluate(
      async ({ expected }) => {
        await window.terminalLatencyDiagnostic?.prepareScrolledBackCase(
          250,
          expected
        )
      },
      { expected: marker }
    )
    await page.locator('#terminal canvas').hover()
    await page.mouse.wheel(0, -100_000)
    await page.keyboard.type(marker, { delay })
    const scrollback = await page.evaluate(
      async ({ expected }) => {
        return await window.terminalLatencyDiagnostic?.finishScrolledBackCase(
          expected
        )
      },
      { expected: marker }
    )
    const lifecycle = await page.evaluate(async () => {
      return await window.terminalLatencyDiagnostic?.runLifecycleCases()
    })
    if (!(scrollback && lifecycle)) {
      throw new Error('The diagnostic page did not return local case reports')
    }
    passed = passed && lifecyclePassed(lifecycle)
    report = { baseline, lifecycle, scrollback }
  } else {
    passed = passed && rpcPassed(baseline)
    report = { baseline }
  }

  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`)
  console.log(
    JSON.stringify(
      {
        baseline: {
          mode: baseline.mode,
          rpc:
            baseline.rpc === undefined
              ? undefined
              : {
                  acknowledgementCount: baseline.rpc.acknowledgements.length,
                  error: baseline.rpc.error,
                  outputExact: baseline.rpc.outputExact,
                  renderedPromptVerified: baseline.rpc.renderedPromptVerified,
                  verificationMode: baseline.rpc.verificationMode,
                  writeCount: baseline.rpc.writes.length,
                },
          rpcSummary: baseline.rpcSummary,
          sequence: baseline.sequence,
          summary: baseline.summary,
        },
        lifecycle: report.lifecycle?.lifecycleCases.map((item) => ({
          canvasOperationsWhileSuppressed: item.canvasOperationsWhileSuppressed,
          contentPreserved: item.contentPreserved,
          kind: item.kind,
          markerVisibleAfterRestore: item.markerVisibleAfterRestore,
          markerVisibleWhileSuppressed: item.markerVisibleWhileSuppressed,
          renderResumed: item.renderResumed,
        })),
        output,
        passed,
        scrollback: report.scrollback?.visibilityCases.map((item) => ({
          canvasSubmissionsWhileScrolledBack:
            item.canvasSubmissionsWhileScrolledBack,
          echoGlyphSubmissionsWhileScrolledBack:
            item.echoGlyphSubmissionsWhileScrolledBack,
          emittedExactly: item.emittedExactly,
          parsedAndScheduled: item.parsedAndScheduled,
          typedVisibleAfterScrollToBottom: item.typedVisibleAfterScrollToBottom,
          typedVisibleWhileScrolledBack: item.typedVisibleWhileScrolledBack,
        })),
      },
      null,
      2
    )
  )
  if (!passed) {
    process.exitCode = 1
  }
} catch (error) {
  if (serverError.length > 0) {
    console.error(serverError)
  }
  throw error
} finally {
  await page
    ?.evaluate(async () => {
      await window.terminalLatencyDiagnostic?.disconnect()
    })
    .catch((error) => {
      console.error('Diagnostic terminal cleanup failed', error)
      process.exitCode = 1
    })
  await browser?.close()
  server.kill('SIGTERM')
}
