/** Canonical Crockford ULIDs used for durable task identities. */

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const MAX_TIMESTAMP = 0xff_ff_ff_ff_ff_ff
const TIME_LENGTH = 10
const RANDOM_LENGTH = 16
const TASK_ULID_PATTERN = /^[0-7][0-9ABCDEFGHJKMNPQRSTVWXYZ]{25}$/

export const createTaskUlid = (time = Date.now()): string => {
  if (!Number.isFinite(time)) {
    throw new RangeError('Task ULID timestamp must be finite')
  }
  let timestamp = Math.max(0, Math.min(Math.trunc(time), MAX_TIMESTAMP))
  let encodedTime = ''
  for (let index = 0; index < TIME_LENGTH; index += 1) {
    encodedTime = CROCKFORD[timestamp % 32] + encodedTime
    timestamp = Math.floor(timestamp / 32)
  }

  const entropy = globalThis.crypto.getRandomValues(
    new Uint8Array(RANDOM_LENGTH)
  )
  let encodedRandom = ''
  for (let index = 0; index < RANDOM_LENGTH; index += 1) {
    encodedRandom += CROCKFORD[(entropy[index] ?? 0) % 32]
  }
  return encodedTime + encodedRandom
}

export const isTaskUlid = (value: string): boolean =>
  TASK_ULID_PATTERN.test(value)
