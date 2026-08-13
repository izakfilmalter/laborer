import { spawn } from 'node:child_process'
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, describe, it } from '@effect/vitest'
import { opencode2Agent } from '../../../.sandcastle/opencode2-agent/index.ts'

const sandcastleMain = readFileSync('../../.sandcastle/main.ts', 'utf8')

const runCommand = async (
  command: string,
  stdin: string,
  env: NodeJS.ProcessEnv
): Promise<string> => {
  const result = await runCommandResult(command, stdin, env)
  if (result.code === 0) {
    return result.stdout
  }
  throw new Error(
    `Fake opencode2 exited ${String(result.code)}: ${result.stderr}`
  )
}

const runCommandResult = async (
  command: string,
  stdin: string,
  env: NodeJS.ProcessEnv
): Promise<{
  readonly code: number | null
  readonly stderr: string
  readonly stdout: string
}> =>
  await new Promise((resolve, reject) => {
    const child = spawn(command, {
      env,
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('close', (code) => {
      resolve({ code, stderr, stdout })
    })
    child.stdin.end(stdin)
  })

describe('Sandcastle opencode2 agent', () => {
  it('uses the available fast OpenAI model for all-around phases', () => {
    assert.include(sandcastleMain, 'opencode2Agent("openai/gpt-5.6-sol-fast"')
    assert.notInclude(sandcastleMain, 'opencode2Agent("openai/gpt-5.6-sol",')
  })

  it('uses the machine-installed CLI and its existing state', () => {
    const packageJson = JSON.parse(
      readFileSync('../../.sandcastle/package.json', 'utf8')
    ) as {
      readonly devDependencies?: Readonly<Record<string, string>>
    }

    assert.notProperty(packageJson.devDependencies ?? {}, '@opencode-ai/cli')
    assert.include(sandcastleMain, 'runFile("opencode2", ["--version"])')
    assert.include(sandcastleMain, 'runFile("opencode2", ["run", "--help"])')
    const rootPackage = JSON.parse(
      readFileSync('../../package.json', 'utf8')
    ) as {
      readonly scripts?: Readonly<Record<string, string>>
    }
    assert.strictEqual(
      rootPackage.scripts?.sandcastle,
      'bun .sandcastle/main.ts'
    )
  })

  it('uses the host OpenCode service with an encoded variant and preserves JSON events', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'laborer-opencode2-'))
    const executable = join(directory, 'opencode2')
    const argsPath = join(directory, 'args')
    const environmentPath = join(directory, 'environment')
    const stdinPath = join(directory, 'stdin')
    writeFileSync(
      executable,
      [
        '#!/bin/sh',
        'printf "%s\\n" "$@" > "$FAKE_OPENCODE_ARGS"',
        'printf "%s" "$OPENCODE_DISABLE_AUTOUPDATE" > "$FAKE_OPENCODE_ENVIRONMENT"',
        'cat > "$FAKE_OPENCODE_STDIN"',
        'printf \'%s\\n\' \'{"type":"step_start","sessionID":"session-1","part":{}}\'',
        'printf \'%s\\n\' \'{"type":"text","part":{"type":"text","text":"finished"}}\'',
        'printf \'%s\\n\' \'{"type":"tool_use","part":{"type":"tool","tool":"bash","state":{"status":"completed","input":{"command":"bun test"}}}}\'',
      ].join('\n')
    )
    chmodSync(executable, 0o755)

    try {
      const agent = opencode2Agent('openai/gpt-5.6-sol', {
        agent: 'build',
        initialStaggerSeconds: 0,
        retryJitterSeconds: 0,
        variant: 'medium',
      })
      const invocation = agent.buildPrintCommand({
        dangerouslySkipPermissions: true,
        prompt: 'Implement safely.\nThen test.',
      })
      assert.notInclude(invocation.command, 'OPENCODE_DB')
      assert.notInclude(invocation.command, '/home/agent')
      const stdout = await runCommand(
        invocation.command,
        invocation.stdin ?? '',
        {
          ...process.env,
          FAKE_OPENCODE_ARGS: argsPath,
          FAKE_OPENCODE_ENVIRONMENT: environmentPath,
          FAKE_OPENCODE_STDIN: stdinPath,
          PATH: `${directory}:${process.env.PATH ?? ''}`,
        }
      )

      assert.deepStrictEqual(
        readFileSync(argsPath, 'utf8').trimEnd().split('\n'),
        [
          'run',
          '--format',
          'json',
          '--model',
          'openai/gpt-5.6-sol#medium',
          '--agent',
          'build',
          '--auto',
        ]
      )
      assert.strictEqual(
        readFileSync(stdinPath, 'utf8'),
        'Implement safely.\nThen test.'
      )
      assert.strictEqual(readFileSync(environmentPath, 'utf8'), '1')
      assert.deepStrictEqual(
        stdout
          .trimEnd()
          .split('\n')
          .flatMap((line) => agent.parseStreamLine(line)),
        [
          { sessionId: 'session-1', type: 'session_id' },
          { text: 'finished', type: 'text' },
          { result: 'finished', type: 'result' },
          { args: 'bun test', name: 'bash', type: 'tool_call' },
        ]
      )
    } finally {
      rmSync(directory, { force: true, recursive: true })
    }
  })

  it('does not auto-approve when Sandcastle preserves permission prompts', () => {
    const invocation = opencode2Agent(
      'anthropic/claude-opus-5'
    ).buildPrintCommand({
      dangerouslySkipPermissions: false,
      prompt: 'Review',
    })

    assert.notInclude(invocation.command, '--auto')
    assert.include(invocation.command, "'anthropic/claude-opus-5'")
  })

  it('makes unattended host auto-approval explicit', () => {
    const invocation = opencode2Agent('fixture/model', {
      dangerouslyAutoApproveHostPermissions: true,
    }).buildPrintCommand({
      dangerouslySkipPermissions: false,
      prompt: 'Build',
    })

    assert.include(invocation.command, '--auto')
  })

  it('continues the existing session after a transient provider failure', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'laborer-opencode2-retry-'))
    const executable = join(directory, 'opencode2')
    const attemptsPath = join(directory, 'attempts')
    const argsPath = join(directory, 'args')
    const stdinPath = join(directory, 'stdin')
    writeFileSync(
      executable,
      [
        '#!/bin/sh',
        'if [ "$1" = "run" ]; then',
        '  printf "%s " "$@" >> "$FAKE_OPENCODE_ARGS"; printf "\\n" >> "$FAKE_OPENCODE_ARGS"',
        '  attempt=$(($(cat "$FAKE_OPENCODE_ATTEMPTS" 2>/dev/null || echo 0) + 1))',
        '  printf "%s" "$attempt" > "$FAKE_OPENCODE_ATTEMPTS"',
        '  cat >> "$FAKE_OPENCODE_STDIN"',
        '  printf "\\n---attempt---\\n" >> "$FAKE_OPENCODE_STDIN"',
        '  if [ "$attempt" -eq 1 ]; then',
        '    printf \'%s\\n\' \'{"type":"step_start","sessionID":"session-failed","part":{}}\'',
        '    exit 1',
        '  fi',
        '  printf \'%s\\n\' \'{"type":"text","part":{"type":"text","text":"recovered"}}\'',
        '  exit 0',
        'fi',
        'if [ "$1" = "api" ] && [ "$2" = "get" ]; then',
        '  if [ "$3" = "/api/session/active" ]; then printf \'%s\\n\' \'{"data":{}}\'; exit 0; fi',
        '  printf \'%s\\n\' \'{"data":[{"type":"assistant","time":{"completed":1},"error":{"type":"provider.internal","message":"temporary provider error"},"content":[]}]}\'',
        '  exit 0',
        'fi',
        'exit 2',
      ].join('\n')
    )
    chmodSync(executable, 0o755)

    try {
      const invocation = opencode2Agent('fixture/model', {
        initialStaggerSeconds: 0,
        maxAttempts: 2,
        recoveryPollSeconds: 0,
        recoveryTimeoutSeconds: 1,
        retryDelaySeconds: 0,
        retryJitterSeconds: 0,
      }).buildPrintCommand({
        dangerouslySkipPermissions: true,
        prompt: 'Continue preserved work.',
      })
      const stdout = await runCommand(
        invocation.command,
        invocation.stdin ?? '',
        {
          ...process.env,
          FAKE_OPENCODE_ATTEMPTS: attemptsPath,
          FAKE_OPENCODE_ARGS: argsPath,
          FAKE_OPENCODE_STDIN: stdinPath,
          PATH: `${directory}:${process.env.PATH ?? ''}`,
        }
      )

      assert.strictEqual(readFileSync(attemptsPath, 'utf8'), '2')
      assert.strictEqual(
        readFileSync(stdinPath, 'utf8'),
        'Continue preserved work.\n---attempt---\nThe previous provider call failed transiently. Continue the existing task from this preserved session and worktree. Do not repeat completed side effects.\n---attempt---\n'
      )
      assert.include(
        readFileSync(argsPath, 'utf8').split('\n')[1] ?? '',
        '--session session-failed'
      )
      assert.include(stdout, '"text":"recovered"')
      assert.include(stdout, 'retrying preserved worktree')
      assert.notInclude(invocation.command, '>&2')
    } finally {
      rmSync(directory, { force: true, recursive: true })
    }
  })

  it('recovers a completed session after the shared event stream disconnects', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'laborer-opencode2-recover-'))
    const executable = join(directory, 'opencode2')
    const diagnosticsPath = join(directory, 'attempts.ndjson')
    const runCountPath = join(directory, 'run-count')
    writeFileSync(
      executable,
      [
        '#!/bin/sh',
        'if [ "$1" = "run" ]; then',
        '  cat >/dev/null',
        '  printf "1" > "$FAKE_OPENCODE_RUN_COUNT"',
        '  printf \'%s\\n\' \'{"type":"step_start","sessionID":"session-recovered","part":{}}\'',
        '  exit 1',
        'fi',
        'if [ "$1" = "api" ] && [ "$2" = "get" ]; then',
        '  if [ "$3" = "/api/session/active" ]; then printf \'%s\\n\' \'{"data":{}}\'; exit 0; fi',
        '  printf \'%s\\n\' \'{"data":[{"type":"assistant","time":{"completed":1},"content":[{"type":"text","text":"<promise>COMPLETE</promise>"}]}]}\'',
        '  exit 0',
        'fi',
        'exit 2',
      ].join('\n')
    )
    chmodSync(executable, 0o755)

    try {
      const agent = opencode2Agent('fixture/model', {
        diagnosticsPath,
        initialStaggerSeconds: 0,
        maxAttempts: 3,
        recoveryPollSeconds: 0,
        recoveryTimeoutSeconds: 1,
        retryDelaySeconds: 0,
        retryJitterSeconds: 0,
      })
      const invocation = agent.buildPrintCommand({
        dangerouslySkipPermissions: true,
        prompt: 'Finish the work.',
      })
      const stdout = await runCommand(
        invocation.command,
        invocation.stdin ?? '',
        {
          ...process.env,
          FAKE_OPENCODE_RUN_COUNT: runCountPath,
          PATH: `${directory}:${process.env.PATH ?? ''}`,
        }
      )

      assert.strictEqual(readFileSync(runCountPath, 'utf8'), '1')
      assert.include(stdout, '<promise>COMPLETE</promise>')
      const diagnostic = JSON.parse(
        readFileSync(diagnosticsPath, 'utf8').trim()
      ) as Record<string, unknown>
      assert.strictEqual(diagnostic.sessionId, 'session-recovered')
      assert.strictEqual(diagnostic.recoveredText, 1)
    } finally {
      rmSync(directory, { force: true, recursive: true })
    }
  })

  it('refuses prompt replay when existing-session recovery is ambiguous', async () => {
    const directory = mkdtempSync(
      join(tmpdir(), 'laborer-opencode2-ambiguous-')
    )
    const executable = join(directory, 'opencode2')
    const runCountPath = join(directory, 'run-count')
    writeFileSync(
      executable,
      [
        '#!/bin/sh',
        'if [ "$1" = "run" ]; then',
        '  cat >/dev/null; printf "run\\n" >> "$FAKE_OPENCODE_RUN_COUNT"',
        '  printf \'%s\\n\' \'{"type":"step_start","sessionID":"session-ambiguous","part":{}}\'',
        '  exit 1',
        'fi',
        'if [ "$1" = "api" ] && [ "$2" = "get" ]; then',
        '  printf \'%s\\n\' \'{"_tag":"ServiceUnavailableError"}\'',
        '  exit 0',
        'fi',
        'exit 2',
      ].join('\n')
    )
    chmodSync(executable, 0o755)

    try {
      const invocation = opencode2Agent('fixture/model', {
        initialStaggerSeconds: 0,
        maxAttempts: 3,
        recoveryPollSeconds: 0,
        recoveryTimeoutSeconds: 0,
        retryDelaySeconds: 0,
        retryJitterSeconds: 0,
      }).buildPrintCommand({
        dangerouslySkipPermissions: true,
        prompt: 'Do not duplicate this work.',
      })

      let failed = false
      try {
        await runCommand(invocation.command, invocation.stdin ?? '', {
          ...process.env,
          FAKE_OPENCODE_RUN_COUNT: runCountPath,
          PATH: `${directory}:${process.env.PATH ?? ''}`,
        })
      } catch {
        failed = true
      }
      assert.isTrue(failed)
      assert.strictEqual(readFileSync(runCountPath, 'utf8'), 'run\n')
    } finally {
      rmSync(directory, { force: true, recursive: true })
    }
  })

  it('surfaces the retained provider cause instead of only Transport', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'laborer-opencode2-cause-'))
    const executable = join(directory, 'opencode2')
    writeFileSync(
      executable,
      [
        '#!/bin/sh',
        'if [ "$1" = "run" ]; then',
        '  cat >/dev/null',
        '  printf \'%s\\n\' \'{"type":"step_start","sessionID":"session-provider-error","part":{}}\'',
        '  printf \'%s\\n\' \'{"type":"error","error":{"message":"Transport"}}\'',
        '  exit 1',
        'fi',
        'if [ "$1" = "api" ] && [ "$2" = "get" ]; then',
        '  if [ "$3" = "/api/session/active" ]; then printf \'%s\\n\' \'{"data":{}}\'; exit 0; fi',
        '  printf \'%s\\n\' \'{"data":[{"type":"assistant","time":{"completed":1},"finish":"error","error":{"type":"provider.internal","message":"server_error request-id-123"},"content":[]}]}\'',
        '  exit 0',
        'fi',
        'exit 2',
      ].join('\n')
    )
    chmodSync(executable, 0o755)

    try {
      const agent = opencode2Agent('fixture/model', {
        initialStaggerSeconds: 0,
        maxAttempts: 1,
        recoveryPollSeconds: 0,
        recoveryTimeoutSeconds: 1,
        retryDelaySeconds: 0,
        retryJitterSeconds: 0,
      })
      const invocation = agent.buildPrintCommand({
        dangerouslySkipPermissions: true,
        prompt: 'Diagnose exactly.',
      })
      const result = await runCommandResult(
        invocation.command,
        invocation.stdin ?? '',
        {
          ...process.env,
          PATH: `${directory}:${process.env.PATH ?? ''}`,
        }
      )

      assert.strictEqual(result.code, 1)
      const parsed = result.stdout
        .trimEnd()
        .split('\n')
        .flatMap((line) => agent.parseStreamLine(line))
      assert.deepInclude(parsed, {
        result: 'server_error request-id-123',
        type: 'result',
      })
    } finally {
      rmSync(directory, { force: true, recursive: true })
    }
  })

  it('fails closed on malformed records and surfaces opencode2 errors', () => {
    const agent = opencode2Agent('fixture/model')

    assert.deepStrictEqual(agent.parseStreamLine('not-json'), [])
    assert.deepStrictEqual(agent.parseStreamLine('{"type":"text"'), [])
    assert.deepStrictEqual(
      agent.parseStreamLine(
        JSON.stringify({
          error: { message: 'provider unavailable' },
          type: 'error',
        })
      ),
      [{ result: 'provider unavailable', type: 'result' }]
    )
  })
})
