/**
 * LifecyclePhaseContext — 4-phase renderer lifecycle inspired by VS Code.
 *
 * Manages a forward-only phase state that progressively enables features
 * as services come online. Phase transitions are irreversible — once the
 * phase advances, it never regresses (even if a service crashes later).
 *
 * ## Phases
 *
 * | Phase | Name | What's Available |
 * |-------|------|------------------|
 * | 1 | Starting | Local OPFS data, navigation, panel layouts |
 * | 2 | Ready | Core RPCs, LiveStore sync, workspace CRUD |
 * | 3 | Restored | Terminals, file watching, full read/write |
 * | 4 | Eventually | Docker, PR tracking, everything |
 *
 * ## Architecture
 *
 * - `LifecyclePhaseProvider` wraps the app root, above all other providers.
 * - `useLifecyclePhase()` returns the current phase.
 * - `advanceTo(phase)` advances the phase forward (no-op if target <= current).
 * - `when(phase)` returns a promise that resolves when the phase is reached
 *   (immediately if already past). Uses a Barrier pattern inspired by VS Code.
 *
 * @see PRD: "4-Phase Renderer Lifecycle", "Lifecycle Phase Service (Renderer)"
 * @see Issue #4: Lifecycle phase enum and context
 */

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from 'react'

/**
 * Forward-only lifecycle phases. Numeric values enable comparison
 * (`phase >= LifecyclePhase.Ready`).
 */
const LifecyclePhase = {
  Starting: 1,
  Ready: 2,
  Restored: 3,
  Eventually: 4,
} as const

type LifecyclePhase = (typeof LifecyclePhase)[keyof typeof LifecyclePhase]

/**
 * A barrier that can be opened once. Waiting on an already-open barrier
 * resolves immediately. Inspired by VS Code's `Barrier` class.
 */
interface Barrier {
  readonly isOpen: boolean
  readonly open: () => void
  readonly wait: () => Promise<void>
}

function createBarrier(): Barrier {
  let isOpen = false
  let resolve: (() => void) | undefined
  const promise = new Promise<void>((r) => {
    resolve = r
  })

  return {
    get isOpen() {
      return isOpen
    },
    wait: () => promise,
    open: () => {
      if (!isOpen) {
        isOpen = true
        resolve?.()
      }
    },
  }
}

interface LifecyclePhaseContextValue {
  /**
   * Advance to a target phase. No-op if target is <= current phase.
   * Forward-only — phases never regress.
   */
  readonly advanceTo: (targetPhase: LifecyclePhase) => void
  /** The current lifecycle phase. */
  readonly phase: LifecyclePhase
  /**
   * Returns a promise that resolves when the specified phase is reached.
   * Resolves immediately if the phase has already been reached.
   */
  readonly when: (targetPhase: LifecyclePhase) => Promise<void>
}

const LifecyclePhaseContext = createContext<LifecyclePhaseContextValue>({
  phase: LifecyclePhase.Starting,
  advanceTo: () => undefined,
  when: () => Promise.resolve(),
})

/**
 * Provider that manages the forward-only lifecycle phase state.
 * Renders above all other providers in the app root.
 */
function LifecyclePhaseProvider({
  children,
}: {
  readonly children: React.ReactNode
}) {
  const [phase, setPhase] = useState<LifecyclePhase>(LifecyclePhase.Starting)

  // One barrier per phase. Created once and never replaced.
  const barriersRef = useRef<Record<LifecyclePhase, Barrier>>({
    [LifecyclePhase.Starting]: createBarrier(),
    [LifecyclePhase.Ready]: createBarrier(),
    [LifecyclePhase.Restored]: createBarrier(),
    [LifecyclePhase.Eventually]: createBarrier(),
  })

  // Starting barrier is always open (we're always at least Starting).
  if (!barriersRef.current[LifecyclePhase.Starting].isOpen) {
    barriersRef.current[LifecyclePhase.Starting].open()
  }

  const advanceTo = useCallback((targetPhase: LifecyclePhase) => {
    setPhase((currentPhase) => {
      if (targetPhase <= currentPhase) {
        return currentPhase
      }

      // Open barriers for all phases up to and including the target.
      const allPhases = [
        LifecyclePhase.Starting,
        LifecyclePhase.Ready,
        LifecyclePhase.Restored,
        LifecyclePhase.Eventually,
      ] as const
      for (const p of allPhases) {
        if (p <= targetPhase) {
          barriersRef.current[p].open()
        }
      }

      return targetPhase
    })
  }, [])

  const when = useCallback((targetPhase: LifecyclePhase) => {
    return barriersRef.current[targetPhase].wait()
  }, [])

  const value = useMemo(
    () => ({ phase, advanceTo, when }),
    [phase, advanceTo, when]
  )

  return <LifecyclePhaseContext value={value}>{children}</LifecyclePhaseContext>
}

/**
 * Returns the current lifecycle phase and transition controls.
 */
function useLifecyclePhase(): LifecyclePhaseContextValue {
  return useContext(LifecyclePhaseContext)
}

export { LifecyclePhase, LifecyclePhaseProvider, useLifecyclePhase }
export type { LifecyclePhaseContextValue }
