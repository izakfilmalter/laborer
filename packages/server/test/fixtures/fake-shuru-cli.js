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
process.stdin.setEncoding('utf8')

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
      type: 'request',
      method: message.method,
      params: message.params ?? null,
    })

    if (message.method === 'stat') {
      if (process.env.LABORER_TEST_SHURU_STAT_ERROR === '1') {
        send({
          jsonrpc: '2.0',
          id: message.id,
          error: {
            code: -32_000,
            message: 'stat /workspace: mount unavailable',
          },
        })
        continue
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
      continue
    }

    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {},
    })
  }
})

process.stdin.on('end', () => {
  record({ type: 'stdin-end' })
  process.exit(0)
})
