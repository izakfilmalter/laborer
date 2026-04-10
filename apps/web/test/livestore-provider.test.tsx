import { cleanup, render } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LiveStoreProvider } from '@/livestore/provider'

const { disposeMock, storeRegistryCtorMock } = vi.hoisted(() => ({
  disposeMock: vi.fn(async () => undefined),
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
})
