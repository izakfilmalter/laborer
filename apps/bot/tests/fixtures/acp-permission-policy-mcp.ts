#!/usr/bin/env node
import { appendFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'

interface JsonRpcRequest {
  readonly id?: number | string
  readonly method?: string
  readonly params?: unknown
}

const observationPath = process.env.ACP_PERMISSION_POLICY_OBSERVATION
if (observationPath === undefined) {
  throw new Error('ACP_PERMISSION_POLICY_OBSERVATION is required')
}

const send = (message: unknown): void => {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

const requestParams = (
  request: JsonRpcRequest
): Readonly<Record<string, unknown>> =>
  typeof request.params === 'object' && request.params !== null
    ? (request.params as Readonly<Record<string, unknown>>)
    : {}

const respond = async (request: JsonRpcRequest): Promise<void> => {
  if (request.id === undefined || request.method === undefined) {
    return
  }
  if (request.method === 'initialize') {
    const protocolVersion = requestParams(request).protocolVersion
    send({
      id: request.id,
      jsonrpc: '2.0',
      result: {
        capabilities: { tools: {} },
        protocolVersion:
          typeof protocolVersion === 'string' ? protocolVersion : '2024-11-05',
        serverInfo: { name: 'laborer-permission-policy', version: '1.0.0' },
      },
    })
    return
  }
  if (request.method === 'tools/list') {
    send({
      id: request.id,
      jsonrpc: '2.0',
      result: {
        tools: [
          {
            description: 'Records one isolated permission-policy invocation.',
            inputSchema: {
              additionalProperties: false,
              properties: { value: { type: 'string' } },
              required: ['value'],
              type: 'object',
            },
            name: 'record',
          },
        ],
      },
    })
    return
  }
  if (request.method === 'tools/call') {
    const params = requestParams(request)
    await appendFile(
      observationPath,
      `${JSON.stringify({ arguments: params.arguments, name: params.name })}\n`,
      { encoding: 'utf8', mode: 0o600 }
    )
    send({
      id: request.id,
      jsonrpc: '2.0',
      result: {
        content: [
          { text: 'permission policy invocation recorded', type: 'text' },
        ],
      },
    })
    return
  }
  if (request.method === 'ping') {
    send({ id: request.id, jsonrpc: '2.0', result: {} })
    return
  }
  send({
    error: { code: -32_601, message: 'Method not found' },
    id: request.id,
    jsonrpc: '2.0',
  })
}

const lines = createInterface({ input: process.stdin, terminal: false })
for await (const line of lines) {
  if (line.trim().length === 0) {
    continue
  }
  try {
    await respond(JSON.parse(line) as JsonRpcRequest)
  } catch {
    send({
      error: { code: -32_700, message: 'Parse error' },
      id: null,
      jsonrpc: '2.0',
    })
  }
}
