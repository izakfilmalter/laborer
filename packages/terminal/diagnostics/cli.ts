import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { NodeRuntime } from '@effect/platform-node'
import { Layer, Schema } from 'effect'
import { runTransportBenchmark } from './transport-benchmark.js'
import {
  type DiagnosticMode,
  diagnosticServerUrl,
  makeDiagnosticServerLayer,
} from './transport-server.js'

const args = process.argv.slice(2)
const command = args[0] ?? 'run'

const option = (name: string): string | undefined => {
  const index = args.indexOf(`--${name}`)
  return index < 0 ? undefined : args[index + 1]
}

const integerOption = (
  name: string,
  fallback: number,
  bounds: { readonly maximum: number; readonly minimum: number }
): number => {
  const raw = option(name)
  if (raw === undefined) {
    return fallback
  }
  const value = Number(raw)
  if (
    !Number.isSafeInteger(value) ||
    value < bounds.minimum ||
    value > bounds.maximum
  ) {
    throw new Error(
      `--${name} must be an integer from ${bounds.minimum} to ${bounds.maximum}`
    )
  }
  return value
}

const modeOption = (): DiagnosticMode => {
  const mode = option('mode') ?? 'minimal'
  if (mode !== 'minimal' && mode !== 'pty') {
    throw new Error('--mode must be minimal or pty')
  }
  return mode
}

const laneOption = (): 'concurrent' | 'serial' => {
  const lane = option('lane') ?? 'serial'
  if (lane !== 'concurrent' && lane !== 'serial') {
    throw new Error('--lane must be serial or concurrent')
  }
  return lane
}

const serverOptions = () => ({
  host: '127.0.0.1',
  loadBlockMs: integerOption('load-block-ms', 0, {
    maximum: 60_000,
    minimum: 0,
  }),
  loadEveryMs: integerOption('load-every-ms', 0, {
    maximum: 60_000,
    minimum: 0,
  }),
  mode: modeOption(),
  port: integerOption('port', 0, { maximum: 65_535, minimum: 0 }),
})

const ReadyMessageSchema = Schema.fromJsonString(
  Schema.Struct({
    loadBlockMs: Schema.Number,
    loadEveryMs: Schema.Number,
    mode: Schema.Literals(['minimal', 'pty']),
    type: Schema.Literal('ready'),
    url: Schema.String,
  })
)

const runServer = () => {
  const options = serverOptions()
  const server = createServer()
  server.once('listening', () => {
    console.log(
      JSON.stringify({
        loadBlockMs: options.loadBlockMs,
        loadEveryMs: options.loadEveryMs,
        mode: options.mode,
        type: 'ready',
        url: diagnosticServerUrl(server),
      })
    )
  })
  NodeRuntime.runMain(Layer.launch(makeDiagnosticServerLayer(options, server)))
}

const runBenchmark = async (url: string) => {
  const report = await runTransportBenchmark({
    lane: laneOption(),
    rate: integerOption('rate', 30, { maximum: 10_000, minimum: 0 }),
    samples: integerOption('samples', 200, {
      maximum: 10_000,
      minimum: 1,
    }),
    timeoutMs: integerOption('timeout-ms', 5000, {
      maximum: 120_000,
      minimum: 1,
    }),
    url,
  })
  console.log(JSON.stringify(report, null, 2))
  if (
    report.missingSamples.length > 0 ||
    report.duplicateSamples > 0 ||
    report.reorderedSamples > 0 ||
    report.rpcFailures > 0 ||
    report.ackFailures > 0
  ) {
    process.exitCode = 1
  }
}

const runIsolated = async () => {
  const options = serverOptions()
  const cliPath = process.argv[1]
  if (cliPath === undefined) {
    throw new Error('Could not resolve diagnostic CLI path')
  }
  const serverArgs = [
    ...process.execArgv,
    cliPath,
    'server',
    '--mode',
    options.mode,
    '--port',
    String(options.port),
    '--load-block-ms',
    String(options.loadBlockMs),
    '--load-every-ms',
    String(options.loadEveryMs),
  ]
  const child = spawn(process.execPath, serverArgs, {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stderr.pipe(process.stderr)
  const ready = new Promise<string>((resolve, reject) => {
    let buffer = ''
    let settled = false
    const fail = (error: Error) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeout)
      reject(error)
    }
    const timeout = setTimeout(() => {
      fail(new Error('Timed out waiting for diagnostic server readiness'))
    }, 15_000)
    child.once('error', (error) => fail(error))
    child.once('exit', (code) => {
      fail(
        new Error(`Diagnostic server exited before readiness (${String(code)})`)
      )
    })
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString()
      while (buffer.includes('\n')) {
        const newline = buffer.indexOf('\n')
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        process.stderr.write(`${line}\n`)
        try {
          const message = Schema.decodeUnknownSync(ReadyMessageSchema)(line)
          if (!settled) {
            settled = true
            clearTimeout(timeout)
            resolve(message.url)
          }
        } catch {
          // Effect startup logs are intentionally forwarded and ignored here.
        }
      }
    })
  })
  try {
    await runBenchmark(await ready)
  } finally {
    child.kill('SIGTERM')
    await Promise.race([
      new Promise<void>((resolve) => child.once('exit', () => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 5000)),
    ])
    if (child.exitCode === null) {
      child.kill('SIGKILL')
      await new Promise<void>((resolve) => child.once('exit', () => resolve()))
    }
  }
}

switch (command) {
  case 'server':
    runServer()
    break
  case 'bench': {
    const url = option('url')
    if (url === undefined) {
      throw new Error('bench requires --url ws://host:port/ws')
    }
    await runBenchmark(url)
    process.exit(process.exitCode ?? 0)
    break
  }
  case 'run':
    await runIsolated()
    process.exit(process.exitCode ?? 0)
    break
  default:
    throw new Error('Expected command: run, server, or bench')
}
