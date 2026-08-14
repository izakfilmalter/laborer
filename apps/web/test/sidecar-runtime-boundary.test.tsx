import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { SidecarRuntimeBoundary } from '@/components/sidecar-runtime-boundary'

describe('SidecarRuntimeBoundary', () => {
  afterEach(cleanup)

  it('leaves reconnect generation to the daemon RPC supervisor', () => {
    render(
      <SidecarRuntimeBoundary>
        {(generation) => <div>{generation}</div>}
      </SidecarRuntimeBoundary>
    )

    expect(screen.getByText('0')).toBeTruthy()
  })
})
