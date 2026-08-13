import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { z } from 'zod'
import { LABORER_VERSION } from '../version.ts'

export const SERVICE_MANAGEMENT_PROTOCOL_VERSION = 1 as const
const MAX_HELPER_OUTPUT_BYTES = 1024
const HELPER_TIMEOUT_MS = 5000

export type ServiceReconciliationState =
  | 'already-registered'
  | 'denied'
  | 'registered'
  | 'requires-approval'
  | 'unavailable'
  | 'version-mismatch'

type ServiceManagementOperation = 'register' | 'status'
export type ServiceManagementRunner = (
  operation: ServiceManagementOperation
) => Promise<string>

const HelperResponse = z
  .object({
    protocolVersion: z.literal(SERVICE_MANAGEMENT_PROTOCOL_VERSION),
    serviceVersion: z.string().trim().min(1).max(64),
    state: z.enum([
      'denied',
      'enabled',
      'not-found',
      'not-registered',
      'requires-approval',
    ]),
  })
  .strict()

const decodeResponse = (source: string) => {
  if (Buffer.byteLength(source, 'utf8') > MAX_HELPER_OUTPUT_BYTES) {
    return null
  }
  try {
    const parsed = HelperResponse.safeParse(JSON.parse(source))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

const mapNativeState = (
  state: 'denied' | 'not-found' | 'requires-approval'
): ServiceReconciliationState => {
  if (state === 'requires-approval') {
    return 'requires-approval'
  }
  return state === 'denied' ? 'denied' : 'unavailable'
}

export const reconcileLaunchAgent = async (
  run: ServiceManagementRunner
): Promise<ServiceReconciliationState> => {
  try {
    const status = decodeResponse(await run('status'))
    if (status === null) {
      return 'unavailable'
    }
    if (status.serviceVersion !== LABORER_VERSION) {
      return 'version-mismatch'
    }
    if (status.state === 'enabled') {
      return 'already-registered'
    }
    if (status.state !== 'not-registered') {
      return mapNativeState(status.state)
    }

    const registration = decodeResponse(await run('register'))
    if (registration === null) {
      return 'unavailable'
    }
    if (registration.serviceVersion !== LABORER_VERSION) {
      return 'version-mismatch'
    }
    if (registration.state === 'enabled') {
      return 'registered'
    }
    if (registration.state === 'not-registered') {
      return 'unavailable'
    }
    return mapNativeState(registration.state)
  } catch {
    return 'unavailable'
  }
}

const execFileAsync = promisify(execFile)

export const makeBundledServiceManagementRunner =
  (helperPath: string): ServiceManagementRunner =>
  async (operation) => {
    const { stdout } = await execFileAsync(helperPath, [operation], {
      encoding: 'utf8',
      env: {},
      maxBuffer: MAX_HELPER_OUTPUT_BYTES,
      timeout: HELPER_TIMEOUT_MS,
    })
    return stdout.trim()
  }
