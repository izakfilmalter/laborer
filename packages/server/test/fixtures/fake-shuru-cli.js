import { appendFileSync } from 'node:fs'

const logPath = process.env.LABORER_TEST_SHURU_LOG_PATH

const record = (event) => {
  if (logPath === undefined || logPath.length === 0) {
    return
  }

  appendFileSync(logPath, `${JSON.stringify(event)}\n`)
}

const send = (message) => {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

const sendNotification = (method, params) => {
  send({ jsonrpc: '2.0', method, params })
}

record({ type: 'argv', argv: process.argv.slice(2) })

process.on('exit', (code) => {
  record({ type: 'exit', code })
})

process.on('SIGTERM', () => {
  record({ type: 'signal', signal: 'SIGTERM' })
  process.exit(0)
})

send({ jsonrpc: '2.0', method: 'ready' })

let remainder = ''
let nextPid = 1
const runningProcesses = new Set()
process.stdin.setEncoding('utf8')

const sendSpawnOutput = (pid) => {
  const stdout =
    process.env.LABORER_TEST_SHURU_SPAWN_STDOUT ?? 'sandbox stdout\n'
  const stderr =
    process.env.LABORER_TEST_SHURU_SPAWN_STDERR ?? 'sandbox stderr\n'

  if (stdout.length > 0 && runningProcesses.has(pid)) {
    sendNotification('output', {
      pid,
      stream: 'stdout',
      data: Buffer.from(stdout).toString('base64'),
    })
  }

  if (stderr.length > 0 && runningProcesses.has(pid)) {
    sendNotification('output', {
      pid,
      stream: 'stderr',
      data: Buffer.from(stderr).toString('base64'),
    })
  }
}

const handleNotification = (message) => {
  if (
    message.method !== 'input' ||
    process.env.LABORER_TEST_SHURU_ECHO_INPUT !== '1' ||
    typeof message.params?.pid !== 'string' ||
    typeof message.params?.data !== 'string'
  ) {
    return
  }

  const input = Buffer.from(message.params.data, 'base64').toString('utf8')
  sendNotification('output', {
    pid: message.params.pid,
    stream: 'stdout',
    data: Buffer.from(`stdin:${input}`).toString('base64'),
  })
}

const handleStatRequest = (message) => {
  if (process.env.LABORER_TEST_SHURU_STAT_ERROR === '1') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      error: {
        code: -32_000,
        message: 'stat /workspace: mount unavailable',
      },
    })
    return
  }

  send({
    jsonrpc: '2.0',
    id: message.id,
    result: {
      size: 4096,
      mode: 16_877,
      mtime: 1_700_000_000,
      is_dir: true,
      is_file: false,
      is_symlink: false,
    },
  })
}

const handleSpawnRequest = (message) => {
  const pid = `proc-${String(nextPid)}`
  nextPid += 1
  runningProcesses.add(pid)

  send({
    jsonrpc: '2.0',
    id: message.id,
    result: { pid },
  })

  queueMicrotask(() => {
    sendSpawnOutput(pid)
  })
}

const handleKillRequest = (message) => {
  const pid = message.params?.pid
  if (typeof pid !== 'string') {
    return false
  }

  runningProcesses.delete(pid)
  send({
    jsonrpc: '2.0',
    id: message.id,
    result: {},
  })
  sendNotification('exit', { pid, code: 0 })
  return true
}

const handleRequest = (message) => {
  if (message.method === 'stat') {
    handleStatRequest(message)
    return
  }

  if (message.method === 'spawn') {
    handleSpawnRequest(message)
    return
  }

  if (message.method === 'kill' && handleKillRequest(message)) {
    return
  }

  send({
    jsonrpc: '2.0',
    id: message.id,
    result: {},
  })
}

process.stdin.on('data', (chunk) => {
  remainder += chunk

  while (true) {
    const newlineIndex = remainder.indexOf('\n')
    if (newlineIndex === -1) {
      break
    }

    const line = remainder.slice(0, newlineIndex)
    remainder = remainder.slice(newlineIndex + 1)

    if (line.trim().length === 0) {
      continue
    }

    const message = JSON.parse(line)
    record({
      type: message.id === undefined ? 'notification' : 'request',
      method: message.method,
      params: message.params ?? null,
    })

    if (message.id === undefined) {
      handleNotification(message)
      continue
    }

    handleRequest(message)
  }
})

process.stdin.on('end', () => {
  record({ type: 'stdin-end' })
  process.exit(0)
})
