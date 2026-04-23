import { cleanup, render } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LiveStoreProvider } from '@/livestore/provider'

const {
  disposeMock,
  isRecoverablePersistenceErrorMock,
  schedulePersistenceResetRecoveryMock,
  storeRegistryCtorMock,
} = vi.hoisted(() => ({
  disposeMock: vi.fn(async () => undefined),
  isRecoverablePersistenceErrorMock: vi.fn(() => false),
  schedulePersistenceResetRecoveryMock: vi.fn(() => false),
  storeRegistryCtorMock: vi.fn(function StoreRegistryMock(this: object) {
    return { dispose: disposeMock }
  }),
}))

vi.mock('@livestore/livestore', () => ({
  StoreRegistry: storeRegistryCtorMock,
}))

vi.mock('@livestore/react', () => ({
  StoreRegistryProvider: ({ children }: { children: ReactNode }) => (
    <>{children}</>
  ),
}))

vi.mock('@/components/loader', () => ({
  default: () => <div>loading</div>,
}))

vi.mock('@/livestore/recovery', () => ({
  isRecoverablePersistenceError: isRecoverablePersistenceErrorMock,
  schedulePersistenceResetRecovery: schedulePersistenceResetRecoveryMock,
}))

describe('LiveStoreProvider', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('disposes the StoreRegistry on unmount', async () => {
    const rendered = render(
      <LiveStoreProvider>
        <div>child</div>
      </LiveStoreProvider>
    )

    expect(storeRegistryCtorMock).toHaveBeenCalledTimes(1)

    rendered.unmount()

    await Promise.resolve()

    expect(disposeMock).toHaveBeenCalledTimes(1)
  })

  it('reloads once after a recoverable LiveStore boot error', () => {
    isRecoverablePersistenceErrorMock.mockReturnValue(true)
    schedulePersistenceResetRecoveryMock.mockReturnValue(true)

    const reloadMock = vi.fn()
    const originalLocation = window.location

    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...originalLocation, reload: reloadMock },
    })

    class RecoverableErrorChild extends Error {
      constructor() {
        super(
          'During boot the backend head (3) should never be greater than the local head (1)'
        )
      }
    }

    const Thrower = () => {
      throw new RecoverableErrorChild()
    }

    try {
      render(
        <LiveStoreProvider>
          <Thrower />
        </LiveStoreProvider>
      )

      expect(isRecoverablePersistenceErrorMock).toHaveBeenCalledTimes(1)
      expect(schedulePersistenceResetRecoveryMock).toHaveBeenCalledTimes(1)
      expect(reloadMock).toHaveBeenCalledTimes(1)
    } finally {
      Object.defineProperty(window, 'location', {
        configurable: true,
        value: originalLocation,
      })
    }
  })
})
