/**
 * The composer contract both surfaces inherit. Surface-specific wiring —
 * payloads, optimism, masking — is covered beside each surface.
 */

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { InlineComposer } from '@/components/inline-composer'

vi.mock('@laborer/ui/components/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
  TooltipTrigger: ({ render }: { render: React.ReactElement }) => render,
}))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const renderComposer = (
  overrides?: Partial<Parameters<typeof InlineComposer>[0]>
) => {
  const commit = overrides?.commit ?? vi.fn().mockResolvedValue(undefined)
  render(
    <InlineComposer
      addon={() => null}
      ariaLabel="Composer"
      commit={commit}
      commitsOnPaste={(text) => text === 'commit-me'}
      composerId="test-composer"
      confirmation={(text) => `Added "${text}".`}
      hint={(text) =>
        text === 'warn' ? { className: 'text-warning', text: 'Careful.' } : null
      }
      idleHint={() => 'Enter to add · Esc to close'}
      onClose={vi.fn()}
      placeholder="Type here"
      {...overrides}
    />
  )
  return {
    commit,
    input: screen.getByRole('textbox', {
      name: (overrides?.ariaLabel as string) ?? 'Composer',
    }) as HTMLInputElement,
  }
}

describe('inline composer', () => {
  it('autofocuses and rests on the idle hint', () => {
    const { input } = renderComposer()

    expect(document.activeElement).toBe(input)
    expect(screen.getByText('Enter to add · Esc to close')).toBeTruthy()
  })

  it('commits on Enter, then clears and stays open for the next one', async () => {
    const user = userEvent.setup()
    const { commit, input } = renderComposer()

    await user.type(input, 'first')
    await user.keyboard('{Enter}')

    await waitFor(() => {
      expect(commit).toHaveBeenCalledWith('first')
    })
    expect(input.value).toBe('')
    expect(screen.getByText('Added "first".')).toBeTruthy()

    await user.type(input, 'second')
    await user.keyboard('{Enter}')
    await waitFor(() => {
      expect(commit).toHaveBeenCalledWith('second')
    })
  })

  it('ignores an empty commit unless the surface says empty is meaningful', async () => {
    const user = userEvent.setup()
    const { commit } = renderComposer()

    await user.keyboard('{Enter}')
    expect(commit).not.toHaveBeenCalled()

    cleanup()
    const withEmpty = renderComposer({ commitsEmpty: true })
    await user.keyboard('{Enter}')
    await waitFor(() => {
      expect(withEmpty.commit).toHaveBeenCalledWith('')
    })
  })

  it('commits a paste the surface recognizes, and only that', async () => {
    const user = userEvent.setup()
    const { commit, input } = renderComposer()

    await user.click(input)
    await user.paste('leave-me')
    await waitFor(() => {
      expect(input.value).toBe('leave-me')
    })
    expect(commit).not.toHaveBeenCalled()

    await user.clear(input)
    await user.paste('commit-me')
    await waitFor(() => {
      expect(commit).toHaveBeenCalledWith('commit-me')
    })
  })

  it('shows the surface hint ahead of the idle line', async () => {
    const user = userEvent.setup()
    const { input } = renderComposer()

    await user.type(input, 'warn')

    await waitFor(() => {
      expect(screen.getByText('Careful.')).toBeTruthy()
    })
    expect(screen.queryByText('Enter to add · Esc to close')).toBeNull()
  })

  it('reports a rejected commit inline and restores the text', async () => {
    const commit = vi.fn().mockRejectedValue(new Error('Nope'))
    const user = userEvent.setup()
    const { input } = renderComposer({ commit })

    await user.type(input, 'doomed')
    await user.keyboard('{Enter}')

    await waitFor(() => {
      expect(screen.getByText('Nope')).toBeTruthy()
    })
    expect(input.value).toBe('doomed')
    expect(input.getAttribute('aria-invalid')).toBe('true')
  })

  it('keeps text the person typed while a commit was failing', async () => {
    let reject: ((cause: unknown) => void) | undefined
    const commit = vi.fn().mockReturnValue(
      new Promise((_resolve, rejectPromise) => {
        reject = rejectPromise
      })
    )
    const user = userEvent.setup()
    const { input } = renderComposer({ commit })

    await user.type(input, 'doomed')
    await user.keyboard('{Enter}')
    await user.type(input, 'next one')

    reject?.(new Error('Nope'))

    await waitFor(() => {
      expect(screen.getByText('Nope')).toBeTruthy()
    })
    expect(input.value).toBe('next one')
  })

  it('hands a failure that outlived the composer to the surface', async () => {
    let reject: ((cause: unknown) => void) | undefined
    const commit = vi.fn().mockReturnValue(
      new Promise((_resolve, rejectPromise) => {
        reject = rejectPromise
      })
    )
    const onFailureWhileClosed = vi.fn()
    const user = userEvent.setup()
    const { input } = renderComposer({ commit, onFailureWhileClosed })

    await user.type(input, 'doomed')
    await user.keyboard('{Enter}')
    cleanup()

    reject?.(new Error('Nope'))

    await waitFor(() => {
      expect(onFailureWhileClosed).toHaveBeenCalledWith('Nope')
    })
    expect(input.isConnected).toBe(false)
  })

  it('cancels on Escape and closes an abandoned empty composer on blur', async () => {
    const onClose = vi.fn()
    const user = userEvent.setup()
    const { input } = renderComposer({ onClose })

    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledWith('cancel')

    input.blur()
    await waitFor(() => {
      expect(onClose).toHaveBeenCalledWith('blur')
    })
  })

  it('keeps a composer with typed text open on blur', async () => {
    const onClose = vi.fn()
    const user = userEvent.setup()
    const { input } = renderComposer({ onClose })

    await user.type(input, 'half a thought')
    input.blur()

    await waitFor(() => {
      expect(input.value).toBe('half a thought')
    })
    expect(onClose).not.toHaveBeenCalled()
  })
})
