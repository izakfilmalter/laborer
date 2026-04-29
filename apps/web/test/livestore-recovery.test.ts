import { beforeEach, describe, expect, it } from 'vitest'
import {
  consumePendingPersistenceReset,
  isRecoverablePersistenceError,
  recoverFromPersistenceError,
  schedulePersistenceResetRecovery,
} from '@/livestore/recovery'

describe('livestore recovery', () => {
  beforeEach(() => {
    window.localStorage.clear()
    window.sessionStorage.clear()
  })

  it('detects recoverable persisted-state errors', () => {
    expect(
      isRecoverablePersistenceError(
        'During boot the backend head (10572) should never be greater than the local head (10570)'
      )
    ).toBe(true)
    expect(
      isRecoverablePersistenceError('Encountered empty or corrupted database')
    ).toBe(true)
    expect(
      isRecoverablePersistenceError(
        'LiveStore.SqliteError: { "query": undefined, "code": -1, "cause": RuntimeError: function signature mismatch, "note": "Failed calling makeChangeset.apply" }'
      )
    ).toBe(true)
    expect(isRecoverablePersistenceError('RPC port closed')).toBe(false)
  })

  it('consumes the pending reset flag once', () => {
    expect(consumePendingPersistenceReset()).toBe(false)

    window.localStorage.setItem(
      'laborer:livestore-reset-persistence-on-next-boot',
      '1'
    )

    expect(consumePendingPersistenceReset()).toBe(true)
    expect(consumePendingPersistenceReset()).toBe(false)
  })

  it('only schedules one automatic reset attempt per session', () => {
    expect(schedulePersistenceResetRecovery()).toBe(true)
    expect(schedulePersistenceResetRecovery()).toBe(false)
    expect(consumePendingPersistenceReset()).toBe(true)
  })

  it('reloads once for recoverable persistence errors', () => {
    let reloadCount = 0

    expect(
      recoverFromPersistenceError(
        'LiveStore.SqliteError: Failed calling makeChangeset.apply',
        () => {
          reloadCount += 1
        }
      )
    ).toBe(true)
    expect(
      recoverFromPersistenceError(
        'LiveStore.SqliteError: Failed calling makeChangeset.apply',
        () => {
          reloadCount += 1
        }
      )
    ).toBe(false)
    expect(reloadCount).toBe(1)
    expect(consumePendingPersistenceReset()).toBe(true)
  })
})
