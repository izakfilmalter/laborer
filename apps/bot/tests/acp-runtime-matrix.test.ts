import { readFile } from 'node:fs/promises'
import { assert, describe, it } from '@effect/vitest'
import {
  ACP_COMPATIBILITY_DIAGNOSTIC_MAX_CHARACTERS,
  assertSupportedOpenCodeInitialization,
  SUPPORTED_ACP_RUNTIME_MATRIX,
} from '../src/acp-compatibility/runtime-matrix.ts'
import {
  makeOpenCodeCompatibilityConfig,
  OPEN_CODE_COMPATIBILITY_PERMISSION_POLICY,
} from './support/opencode-acp-harness.ts'

const COMPATIBILITY_FAILURE_PATTERN = /OpenCode ACP compatibility check failed/
const LOAD_SESSION_PATTERN = /agentCapabilities\.loadSession/
const FROZEN_INSTALL_PATTERN = /bun install --frozen-lockfile/

const supportedInitialization = {
  agentCapabilities: {
    loadSession: false,
    mcpCapabilities: { http: true, sse: false },
    promptCapabilities: { embeddedContext: true, image: true },
    sessionCapabilities: { close: {}, list: {}, resume: {} },
  },
  agentInfo: {
    name: 'OpenCode',
    version: SUPPORTED_ACP_RUNTIME_MATRIX.openCodeCli,
  },
  protocolVersion: 1,
}

const captureFailure = (operation: () => void): Error => {
  try {
    operation()
  } catch (cause) {
    assert.ok(cause instanceof Error)
    return cause
  }
  assert.fail('expected operation to fail')
}

describe('issue #243 ACP runtime matrix', () => {
  it('keeps package pins synchronized with the supported matrix', async () => {
    const [packageSource, nodeVersion] = await Promise.all([
      readFile(new URL('../package.json', import.meta.url), 'utf8'),
      readFile(new URL('../.node-version', import.meta.url), 'utf8'),
    ])
    const packageJson = JSON.parse(packageSource) as {
      dependencies: Record<string, string>
      devDependencies: Record<string, string>
      engines: { node: string }
      packageManager: string
    }
    assert.strictEqual(
      packageJson.dependencies['@agentclientprotocol/sdk'],
      SUPPORTED_ACP_RUNTIME_MATRIX.acpSdk
    )
    assert.strictEqual(
      packageJson.dependencies['@opencode-ai/client'],
      SUPPORTED_ACP_RUNTIME_MATRIX.openCodeClient
    )
    assert.strictEqual(
      packageJson.devDependencies['@opencode-ai/cli'],
      SUPPORTED_ACP_RUNTIME_MATRIX.openCodeCli
    )
    assert.strictEqual(
      packageJson.dependencies.chat,
      SUPPORTED_ACP_RUNTIME_MATRIX.chat
    )
    assert.strictEqual(
      packageJson.dependencies['@slack/web-api'],
      SUPPORTED_ACP_RUNTIME_MATRIX.slackWebApi
    )
    assert.strictEqual(
      packageJson.dependencies['@chat-adapter/slack'],
      SUPPORTED_ACP_RUNTIME_MATRIX.chatSlackAdapter
    )
    assert.strictEqual(
      packageJson.engines.node,
      SUPPORTED_ACP_RUNTIME_MATRIX.node
    )
    assert.strictEqual(
      packageJson.packageManager,
      `bun@${SUPPORTED_ACP_RUNTIME_MATRIX.bun}`
    )
    assert.strictEqual(nodeVersion.trim(), SUPPORTED_ACP_RUNTIME_MATRIX.node)
  })

  it('accepts the exact supported OpenCode capability surface', () => {
    assert.doesNotThrow(() =>
      assertSupportedOpenCodeInitialization(supportedInitialization)
    )
  })

  it('keeps compatibility verification least-privileged', () => {
    assert.deepStrictEqual(OPEN_CODE_COMPATIBILITY_PERMISSION_POLICY, {
      '*': 'deny',
      compat_record: 'ask',
    })
    assert.deepStrictEqual(
      makeOpenCodeCompatibilityConfig('http://127.0.0.1/fixture').permissions,
      [
        { action: '*', effect: 'deny', resource: '*' },
        { action: 'execute', effect: 'allow', resource: '*' },
        { action: 'compat_record', effect: 'ask', resource: '*' },
      ]
    )
  })

  it('reports changed and missing capabilities actionably and bounded', () => {
    const cause = captureFailure(() =>
      assertSupportedOpenCodeInitialization({
        ...supportedInitialization,
        agentCapabilities: 'DO_NOT_RENDER_'.repeat(10_000),
      })
    )
    assert.match(cause.message, COMPATIBILITY_FAILURE_PATTERN)
    assert.match(cause.message, LOAD_SESSION_PATTERN)
    assert.ok(
      cause.message.length <= ACP_COMPATIBILITY_DIAGNOSTIC_MAX_CHARACTERS
    )
    assert.ok(!cause.message.includes('DO_NOT_RENDER_DO_NOT_RENDER'))
    assert.match(cause.message, FROZEN_INSTALL_PATTERN)
  })
})
