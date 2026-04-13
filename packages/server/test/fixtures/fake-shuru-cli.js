import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const logPath = process.env.LABORER_TEST_SHURU_LOG_PATH
const checkpointDirOverride =
  process.env.LABORER_TEST_SHURU_CHECKPOINT_DIR?.trim()
const checkpointDir =
  checkpointDirOverride && checkpointDirOverride.length > 0
    ? checkpointDirOverride
    : join(homedir(), '.local', 'share', 'shuru', 'checkpoints')
const STATE_COMMAND_SPLIT_PATTERN = /\s+/u

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

const runArgs = process.argv.slice(2)

record({ type: 'argv', argv: runArgs })

const checkpointPath = (name) => join(checkpointDir, `${name}.ext4`)

const readCheckpointState = (name) => {
  try {
    const raw = readFileSync(checkpointPath(name), 'utf8')
    const parsed = JSON.parse(raw)
    return typeof parsed.runtimeState === 'string' ? parsed.runtimeState : ''
  } catch {
    return ''
  }
}

const fromCheckpointFlagIndex = runArgs.indexOf('--from')
const fromCheckpointName =
  fromCheckpointFlagIndex >= 0
    ? (runArgs[fromCheckpointFlagIndex + 1] ?? null)
    : null

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
let runtimeState =
  fromCheckpointName === null ? '' : readCheckpointState(fromCheckpointName)
process.stdin.setEncoding('utf8')

const STATE_COMMAND_NAME = 'laborer-test-state'

const resolveStateCommand = (argv) => {
  if (!Array.isArray(argv)) {
    return null
  }

  if (!argv.every((value) => typeof value === 'string')) {
    return null
  }

  if (argv[0] === STATE_COMMAND_NAME) {
    return argv
  }

  if (argv[0] !== 'sh' || argv[1] !== '-lc' || typeof argv[2] !== 'string') {
    return null
  }

  const command = argv[2].trim()
  if (!command.startsWith(`${STATE_COMMAND_NAME} `)) {
    return null
  }

  return command.split(STATE_COMMAND_SPLIT_PATTERN)
}

const applyStateCommand = (argv) => {
  const stateCommand = resolveStateCommand(argv)
  if (stateCommand === null) {
    return null
  }

  if (stateCommand[1] === 'set') {
    runtimeState = stateCommand.slice(2).join(' ')
    return `${runtimeState}\n`
  }

  if (stateCommand[1] === 'get') {
    return `${runtimeState}\n`
  }

  return 'invalid-state-command\n'
}

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
  const stateCommandOutput = applyStateCommand(message.params?.argv)

  send({
    jsonrpc: '2.0',
    id: message.id,
    result: { pid },
  })

  queueMicrotask(() => {
    if (typeof stateCommandOutput === 'string') {
      if (runningProcesses.has(pid)) {
        sendNotification('output', {
          pid,
          stream: 'stdout',
          data: Buffer.from(stateCommandOutput).toString('base64'),
        })
      }

      runningProcesses.delete(pid)
      sendNotification('exit', { pid, code: 0 })
      return
    }

    sendSpawnOutput(pid)
  })
}

const handleExecRequest = (message) => {
  const stateCommandOutput = applyStateCommand(message.params?.argv)
  if (typeof stateCommandOutput === 'string') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        stdout: stateCommandOutput,
        stderr: '',
        exit_code: 0,
      },
    })
    return
  }

  const stdout = process.env.LABORER_TEST_SHURU_EXEC_STDOUT ?? ''
  const stderr = process.env.LABORER_TEST_SHURU_EXEC_STDERR ?? ''
  const exitCode = Number.parseInt(
    process.env.LABORER_TEST_SHURU_EXEC_EXIT_CODE ?? '0',
    10
  )

  send({
    jsonrpc: '2.0',
    id: message.id,
    result: {
      stdout,
      stderr,
      exit_code: Number.isNaN(exitCode) ? 0 : exitCode,
    },
  })
}

const handleCheckpointRequest = (message) => {
  const name = message.params?.name
  if (typeof name !== 'string' || name.length === 0) {
    return false
  }

  mkdirSync(checkpointDir, { recursive: true })
  writeFileSync(checkpointPath(name), JSON.stringify({ runtimeState }, null, 2))
  writeFileSync(join(checkpointDir, `${name}.idx`), 'checkpoint-index')

  send({
    jsonrpc: '2.0',
    id: message.id,
    result: {},
  })
  return true
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

  if (message.method === 'exec') {
    handleExecRequest(message)
    return
  }

  if (message.method === 'checkpoint' && handleCheckpointRequest(message)) {
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
