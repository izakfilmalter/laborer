#!/usr/bin/env node
// One-shot operator tool: reauthorize the Laborer Slack app into a workspace.
//
// Starts a loopback callback server, exposes it through Tailscale Funnel at the
// app's registered redirect URL, opens Slack's authorize page with the
// manifest's bot scopes, exchanges the returned code, stores the new bot token
// in Keychain, then tears the Funnel down. The daemon itself never runs this.
//
// Usage: node scripts/slack-install.mjs <freckle|steeple>

import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const CLIENT_ID = '1213883857746.11656547604037'
const CLIENT_SECRET_SERVICE = 'laborer-slack-client-secret-steeple'
const CALLBACK_PATH = '/slack/oauth/callback'
const CALLBACK_PORT = 8787
const AUTHORIZE_TIMEOUT_MILLIS = 10 * 60 * 1000
const MACOS_TAILSCALE = '/Applications/Tailscale.app/Contents/MacOS/Tailscale'
const MANIFEST_BOT_SCOPES = /^ {4}bot:\n((?: {6}- .+\n)+)/m
const MANIFEST_LIST_ITEM = /^ {6}- /
const TRAILING_DOT = /\.$/
const WORKSPACES = {
  freckle: {
    teamId: 'T04UDJP9283',
    tokenService: 'laborer-slack-bot-token-freckle',
  },
  steeple: {
    teamId: 'T0169RZR7MY',
    tokenService: 'laborer-slack-bot-token-steeple',
  },
}

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const manifestPath = resolve(scriptDirectory, '../slack-app-manifest.yaml')
const account = process.env.USER ?? ''

const fail = (message) => {
  throw new Error(message)
}

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options })
  if (result.status !== 0) {
    fail(
      `${command} ${args.join(' ')} failed: ${(result.stderr || result.stdout || '').trim() || `status ${result.status}`}`
    )
  }
  return result.stdout
}

const tailscale = (...args) =>
  run(
    process.env.TAILSCALE_BIN ??
      (existsSync(MACOS_TAILSCALE) ? MACOS_TAILSCALE : 'tailscale'),
    args
  )

const keychainRead = (service) =>
  run('security', [
    'find-generic-password',
    '-a',
    account,
    '-s',
    service,
    '-w',
  ]).trim()

const keychainWrite = (service, value) =>
  run('security', [
    'add-generic-password',
    '-U',
    '-a',
    account,
    '-s',
    service,
    '-w',
    value,
  ])

const manifestBotScopes = () => {
  const manifest = readFileSync(manifestPath, 'utf8')
  const block = MANIFEST_BOT_SCOPES.exec(manifest)
  if (block === null) {
    fail(`No bot scopes found in ${manifestPath}`)
  }
  return block[1]
    .split('\n')
    .map((line) => line.replace(MANIFEST_LIST_ITEM, '').trim())
    .filter((scope) => scope.length > 0)
}

const tailnetHostname = () => {
  const status = JSON.parse(tailscale('status', '--json'))
  if (status.BackendState !== 'Running') {
    fail(`Tailscale is not running (${status.BackendState})`)
  }
  const dnsName = status.Self?.DNSName
  if (typeof dnsName !== 'string' || dnsName.length === 0) {
    fail('Tailscale did not report a MagicDNS hostname')
  }
  return dnsName.replace(TRAILING_DOT, '')
}

const funnelIsConfigured = () => {
  const status = JSON.parse(tailscale('funnel', 'status', '--json') || '{}')
  return Object.keys(status.Web ?? {}).length > 0
}

const respond = (response, status, message) => {
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Type': 'text/plain; charset=utf-8',
  })
  response.end(`${message}\n`)
}

const exchangeCode = async (code, redirectUri, workspace, requiredScopes) => {
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: keychainRead(CLIENT_SECRET_SERVICE),
    code,
    redirect_uri: redirectUri,
  })
  const response = await fetch('https://slack.com/api/oauth.v2.access', {
    body,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    method: 'POST',
    signal: AbortSignal.timeout(15_000),
  })
  const payload = await response.json()
  if (payload?.ok !== true || typeof payload.access_token !== 'string') {
    fail(`Slack token exchange failed: ${payload?.error ?? 'invalid-response'}`)
  }
  if (payload.team?.id !== workspace.teamId) {
    fail(
      `Slack authorized ${payload.team?.id ?? 'unknown'} but ${workspace.teamId} was expected; token discarded`
    )
  }
  const granted = new Set(String(payload.scope ?? '').split(','))
  const missing = requiredScopes.filter((scope) => !granted.has(scope))
  if (missing.length > 0) {
    fail(`Slack granted a token without ${missing.join(', ')}; token discarded`)
  }
  return { scope: payload.scope, token: payload.access_token }
}

// Returns { code } for a valid callback, { rejected: Error } when Slack
// reported an error, or undefined after answering an irrelevant request.
const classifyCallback = (request, response, state) => {
  const url = new URL(request.url ?? '/', `http://127.0.0.1:${CALLBACK_PORT}`)
  if (request.method !== 'GET' || url.pathname !== CALLBACK_PATH) {
    respond(response, 404, 'Not found.')
    return
  }
  if (url.searchParams.get('state') !== state) {
    respond(response, 400, 'Unexpected OAuth state.')
    return
  }
  const slackError = url.searchParams.get('error')
  if (slackError !== null) {
    const message = `Slack authorization failed: ${slackError}`
    respond(response, 400, message)
    return { rejected: new Error(message) }
  }
  const code = url.searchParams.get('code')
  if (code === null || code.length === 0) {
    respond(response, 400, 'Missing code.')
    return
  }
  return { code }
}

const awaitCallback = (state, onCode) =>
  new Promise((resolvePromise, rejectPromise) => {
    const server = createServer(async (request, response) => {
      const callback = classifyCallback(request, response, state)
      if (callback === undefined) {
        return
      }
      if (callback.rejected) {
        finish(callback.rejected)
        return
      }
      try {
        const outcome = await onCode(callback.code)
        respond(
          response,
          200,
          `Laborer was reauthorized. Granted scopes: ${outcome.scope}. You can close this tab.`
        )
        finish(undefined, outcome)
      } catch (error) {
        respond(
          response,
          500,
          error instanceof Error ? error.message : String(error)
        )
        finish(error)
      }
    })
    const timer = setTimeout(
      () => finish(new Error('Timed out waiting for Slack authorization')),
      AUTHORIZE_TIMEOUT_MILLIS
    )
    let settled = false
    const finish = (error, outcome) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      server.close()
      if (error) {
        rejectPromise(error)
      } else {
        resolvePromise(outcome)
      }
    }
    server.once('error', finish)
    server.listen(CALLBACK_PORT, '127.0.0.1')
  })

const main = async () => {
  const workspaceName = process.argv[2]
  const workspace = WORKSPACES[workspaceName]
  if (workspace === undefined) {
    fail(`Usage: slack-install.mjs <${Object.keys(WORKSPACES).join('|')}>`)
  }
  if (account.length === 0) {
    fail('USER is unavailable')
  }
  keychainRead(CLIENT_SECRET_SERVICE)

  const scopes = manifestBotScopes()
  const hostname = tailnetHostname()
  const redirectUri = `https://${hostname}${CALLBACK_PATH}`
  if (funnelIsConfigured()) {
    fail(
      'Tailscale Funnel is already configured on this machine; refusing to replace it. Run `tailscale funnel reset` if that is stale.'
    )
  }

  const state = randomBytes(16).toString('hex')
  const authorizeUrl = new URL('https://slack.com/oauth/v2/authorize')
  authorizeUrl.searchParams.set('client_id', CLIENT_ID)
  authorizeUrl.searchParams.set('scope', scopes.join(','))
  authorizeUrl.searchParams.set('redirect_uri', redirectUri)
  authorizeUrl.searchParams.set('state', state)

  const pending = awaitCallback(state, (code) =>
    exchangeCode(code, redirectUri, workspace, scopes)
  )
  tailscale('funnel', '--bg', '--yes', String(CALLBACK_PORT))
  process.stdout.write(
    `Funnel: ${redirectUri} -> 127.0.0.1:${CALLBACK_PORT}\nScopes: ${scopes.join(',')}\nOpening Slack authorization for ${workspaceName} (${workspace.teamId})...\n`
  )
  spawn('open', [authorizeUrl.toString()], { stdio: 'ignore' }).unref()
  process.stdout.write(`If the browser did not open:\n${authorizeUrl}\n`)

  try {
    const { token } = await pending
    keychainWrite(workspace.tokenService, token)
    process.stdout.write(
      `Stored the new ${workspaceName} bot token in Keychain (${workspace.tokenService}). Restart the daemon to use it.\n`
    )
  } finally {
    try {
      tailscale('funnel', 'reset')
      process.stdout.write('Funnel disabled.\n')
    } catch (error) {
      process.stderr.write(
        `Funnel was not reset; run \`tailscale funnel reset\` manually. ${error instanceof Error ? error.message : String(error)}\n`
      )
    }
  }
}

try {
  await main()
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`
  )
  process.exitCode = 1
}
