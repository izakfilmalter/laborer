import { describe, expect, it } from 'vitest'
import {
  INITIAL_WEBVIEW_CRASH_RECOVERY_STATE,
  planWebviewCrashRecovery,
  WEBVIEW_CRASH_RECOVERY_WINDOW_MS,
} from '@/browser/webview-crash-recovery'

describe('webview crash recovery', () => {
  it('backs off and stops after three rapid guest crashes', () => {
    const first = planWebviewCrashRecovery(
      INITIAL_WEBVIEW_CRASH_RECOVERY_STATE,
      1000
    )
    expect(first).not.toBeNull()
    if (!first) {
      return
    }
    const second = planWebviewCrashRecovery(first.state, 1100)
    expect(second).not.toBeNull()
    if (!second) {
      return
    }
    const third = planWebviewCrashRecovery(second.state, 1200)
    expect(third).not.toBeNull()
    if (!third) {
      return
    }
    expect([first.delayMs, second.delayMs, third.delayMs]).toEqual([
      250, 500, 1000,
    ])
    expect(planWebviewCrashRecovery(third.state, 1300)).toBeNull()
  })

  it('starts recovery again after the bounded crash window', () => {
    const state = { attempts: 3, windowStartedAt: 1000 }
    expect(
      planWebviewCrashRecovery(state, 1000 + WEBVIEW_CRASH_RECOVERY_WINDOW_MS)
    ).toEqual({
      delayMs: 250,
      state: {
        attempts: 1,
        windowStartedAt: 1000 + WEBVIEW_CRASH_RECOVERY_WINDOW_MS,
      },
    })
  })
})
