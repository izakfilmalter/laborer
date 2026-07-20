/**
 * Context for controlling the app settings modal from components
 * that live outside the LiveStoreProvider tree (e.g. Header).
 *
 * The open/close state is lifted here so that Header can trigger
 * "open settings" while the actual AppSettingsModal renders inside
 * LiveStoreProvider where it has store access.
 */

import { createContext, useCallback, useContext, useState } from 'react'

interface AppSettingsContextValue {
  readonly onOpenChange: (open: boolean) => void
  readonly open: boolean
}

const AppSettingsContext = createContext<AppSettingsContextValue>({
  open: false,
  onOpenChange: () => undefined,
})

function AppSettingsProvider({
  children,
}: {
  readonly children: React.ReactNode
}) {
  const [open, setOpen] = useState(false)

  const onOpenChange = useCallback((next: boolean) => {
    setOpen(next)
  }, [])

  return (
    <AppSettingsContext value={{ open, onOpenChange }}>
      {children}
    </AppSettingsContext>
  )
}

function useAppSettings(): AppSettingsContextValue {
  return useContext(AppSettingsContext)
}

export { AppSettingsProvider, useAppSettings }
