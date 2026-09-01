import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { toast } from 'sonner'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { Toaster } from '../src/components/sonner'

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  vi.stubGlobal('matchMedia', () => ({
    addEventListener: vi.fn(),
    matches: false,
    removeEventListener: vi.fn(),
  }))
})

afterEach(() => {
  toast.dismiss()
  document.body.innerHTML = ''
})

describe('Toaster', () => {
  it('keeps the loading glyph centered inside its rotating wrapper', async () => {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)

    act(() => {
      root.render(<Toaster />)
    })
    await act(async () => {
      toast.loading('Writing the pull request…')
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    const loadingIcon = document.querySelector(
      '[data-sonner-toast][data-type="loading"] [data-icon] svg'
    )

    expect(loadingIcon).toBeInstanceOf(SVGElement)
    expect(getComputedStyle(loadingIcon as SVGElement).marginLeft).toBe('0px')

    act(() => {
      root.unmount()
    })
  })
})
