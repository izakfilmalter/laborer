import { ThemeProvider as NextThemesProvider } from 'next-themes'
import type * as React from 'react'

export function ThemeProvider({
  children,
  ...props
}: React.ComponentProps<typeof NextThemesProvider>) {
  return <NextThemesProvider {...props}>{children}</NextThemesProvider>
}

// biome-ignore lint/performance/noBarrelFile: this is the way
export { useTheme } from 'next-themes'
