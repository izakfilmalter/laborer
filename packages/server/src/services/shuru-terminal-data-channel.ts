import type { RpcMessagePort } from '@laborer/shared/rpc-transport-messageport'

import {
  getShuruTerminalHandle,
  removeShuruTerminalHandle,
} from './shuru-client.js'

const encodeError = (message: string): string =>
  JSON.stringify({ type: 'error', message })

const encodeStatus = (status: string, exitCode?: number): string => {
  const message: Record<string, unknown> = { type: 'status', status }
  if (exitCode !== undefined) {
    message.exitCode = exitCode
  }
  return JSON.stringify(message)
}

function parseClientMessage(
  data: string
): { type: 'ack'; chars: number } | null {
  if (data.length > 0 && data[0] === '{' && data.endsWith('}')) {
    try {
      const parsed = JSON.parse(data) as { chars?: number; type?: string }
      if (parsed.type === 'ack' && typeof parsed.chars === 'number') {
        return { type: 'ack', chars: parsed.chars }
      }
    } catch {
      // Treat invalid JSON as raw terminal input.
    }
  }

  return null
}

const attachShuruDataChannel = (
  port: RpcMessagePort,
  terminalId: string
): void => {
  const handle = getShuruTerminalHandle(terminalId)
  if (handle === undefined) {
    port.postMessage(encodeError(`Shuru terminal not found: ${terminalId}`))
    port.close?.()
    return
  }
  const terminalHandle = handle

  const portSend = (data: string): void => {
    try {
      port.postMessage(data)
    } catch {
      // The renderer may have already disconnected.
    }
  }

  const status = terminalHandle.getStatus()
  const exitCode = terminalHandle.getExitCode() ?? undefined
  portSend(encodeStatus(status, exitCode))

  const queuedOutput: string[] = []
  let isRestoringBuffer = true

  const sendOutput = (data: string): void => {
    if (isRestoringBuffer) {
      queuedOutput.push(data)
      return
    }

    portSend(data)
  }

  const unsubscribeOutput = terminalHandle.onOutput(sendOutput)
  const unsubscribeExit = terminalHandle.onExit((code) => {
    portSend(encodeStatus('stopped', code))
    cleanup()
  })

  const bufferedOutput = terminalHandle.getBufferedOutput()
  if (bufferedOutput.length > 0) {
    portSend(bufferedOutput)
  }

  isRestoringBuffer = false
  for (const chunk of queuedOutput) {
    portSend(chunk)
  }

  const messageHandler = (data: unknown): void => {
    if (typeof data !== 'string') {
      return
    }

    const message = parseClientMessage(data)
    if (message !== null) {
      return
    }

    terminalHandle.write(data)
  }

  const unwrapData = (value: unknown): unknown => {
    if (typeof value === 'object' && value !== null && 'data' in value) {
      return (value as { data: unknown }).data
    }
    return value
  }

  const nodeListener = (value: unknown): void => {
    messageHandler(unwrapData(value))
  }

  if (typeof port.on === 'function') {
    port.on('message', nodeListener)
  } else {
    port.onmessage = (event: { data: unknown }) => {
      messageHandler(event.data)
    }
  }

  port.start?.()

  function cleanup(): void {
    unsubscribeOutput()
    unsubscribeExit()

    if (typeof port.off === 'function') {
      port.off('message', nodeListener)
    } else if (typeof port.removeListener === 'function') {
      port.removeListener('message', nodeListener)
    } else {
      port.onmessage = null
    }

    if (terminalHandle.getStatus() === 'stopped') {
      removeShuruTerminalHandle(terminalId)
    }

    port.close?.()
  }
}

const handleShuruTerminalDataPort = (
  port: RpcMessagePort,
  terminalId: string
): void => {
  attachShuruDataChannel(port, terminalId)
}

export {
  attachShuruDataChannel,
  handleShuruTerminalDataPort,
  parseClientMessage,
}
