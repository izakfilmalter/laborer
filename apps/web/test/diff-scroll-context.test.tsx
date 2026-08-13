/**
 * Tests for DiffScrollContext — cross-pane communication for scrolling
 * the diff pane to a specific file and line.
 *
 * Verifies that the context correctly dispatches scroll events to
 * subscribed listeners, filters by workspace ID, handles multiple
 * listeners, and cleans up on unmount.
 *
 * @see Issue #11: Cross-pane diff scroll
 */

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DiffScrollProvider,
  useDiffScrollDispatch,
  useOnDiffScrollRequest,
} from '../src/panels/diff-scroll-context'

/**
 * Test component that dispatches a scroll event when a button is clicked.
 */
function Dispatcher({
  file,
  line,
  workspaceId,
}: {
  readonly file: string
  readonly line: number
  readonly workspaceId: string
}) {
  const scrollDiffToFile = useDiffScrollDispatch()
  return (
    <button
      onClick={() => scrollDiffToFile(workspaceId, file, line)}
      type="button"
    >
      Scroll
    </button>
  )
}

/**
 * Test component that subscribes to scroll events and displays the
 * received target.
 */
function Receiver({
  onScroll,
  workspaceId,
}: {
  readonly onScroll: (target: { file: string; line: number }) => void
  readonly workspaceId: string
}) {
  useOnDiffScrollRequest(workspaceId, onScroll)
  return <div data-testid="receiver">Listening on {workspaceId}</div>
}

describe('DiffScrollContext', () => {
  afterEach(() => {
    cleanup()
  })

  it('dispatches scroll event to a subscribed listener', async () => {
    const user = userEvent.setup()
    const onScroll = vi.fn()

    render(
      <DiffScrollProvider>
        <Dispatcher file="src/index.ts" line={42} workspaceId="ws-1" />
        <Receiver onScroll={onScroll} workspaceId="ws-1" />
      </DiffScrollProvider>
    )

    await user.click(screen.getByText('Scroll'))

    expect(onScroll).toHaveBeenCalledTimes(1)
    expect(onScroll).toHaveBeenCalledWith({ file: 'src/index.ts', line: 42 })
  })

  it('only dispatches to listeners matching the workspace ID', async () => {
    const user = userEvent.setup()
    const onScrollWs1 = vi.fn()
    const onScrollWs2 = vi.fn()

    render(
      <DiffScrollProvider>
        <Dispatcher file="src/app.ts" line={10} workspaceId="ws-1" />
        <Receiver onScroll={onScrollWs1} workspaceId="ws-1" />
        <Receiver onScroll={onScrollWs2} workspaceId="ws-2" />
      </DiffScrollProvider>
    )

    await user.click(screen.getByText('Scroll'))

    expect(onScrollWs1).toHaveBeenCalledTimes(1)
    expect(onScrollWs2).not.toHaveBeenCalled()
  })

  it('supports multiple listeners for the same workspace', async () => {
    const user = userEvent.setup()
    const onScroll1 = vi.fn()
    const onScroll2 = vi.fn()

    render(
      <DiffScrollProvider>
        <Dispatcher file="src/utils.ts" line={5} workspaceId="ws-1" />
        <Receiver onScroll={onScroll1} workspaceId="ws-1" />
        <Receiver onScroll={onScroll2} workspaceId="ws-1" />
      </DiffScrollProvider>
    )

    await user.click(screen.getByText('Scroll'))

    expect(onScroll1).toHaveBeenCalledTimes(1)
    expect(onScroll2).toHaveBeenCalledTimes(1)
  })

  it('unsubscribes listener on unmount', async () => {
    const user = userEvent.setup()
    const onScroll = vi.fn()

    function ConditionalReceiver({ show }: { readonly show: boolean }) {
      return show ? <Receiver onScroll={onScroll} workspaceId="ws-1" /> : null
    }

    const { rerender } = render(
      <DiffScrollProvider>
        <Dispatcher file="src/a.ts" line={1} workspaceId="ws-1" />
        <ConditionalReceiver show={true} />
      </DiffScrollProvider>
    )

    // First click — listener should fire
    await user.click(screen.getByText('Scroll'))
    expect(onScroll).toHaveBeenCalledTimes(1)

    // Unmount the receiver
    rerender(
      <DiffScrollProvider>
        <Dispatcher file="src/a.ts" line={1} workspaceId="ws-1" />
        <ConditionalReceiver show={false} />
      </DiffScrollProvider>
    )

    // Second click — listener should NOT fire (unmounted)
    await user.click(screen.getByText('Scroll'))
    expect(onScroll).toHaveBeenCalledTimes(1)
  })

  it('silently ignores events when no listeners are subscribed', async () => {
    const user = userEvent.setup()

    render(
      <DiffScrollProvider>
        <Dispatcher file="src/b.ts" line={99} workspaceId="ws-1" />
      </DiffScrollProvider>
    )

    // Should not throw
    await user.click(screen.getByText('Scroll'))
  })

  it('dispatch is a no-op when no provider is present', async () => {
    const user = userEvent.setup()

    // Render without provider — useDiffScrollDispatch returns a no-op
    render(<Dispatcher file="src/c.ts" line={1} workspaceId="ws-1" />)

    // Should not throw
    await user.click(screen.getByText('Scroll'))
  })
})
