import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from 'lucide-react'
import { useTheme } from 'next-themes'
import { Toaster as Sonner, type ToasterProps } from 'sonner'

const Toaster = ({ theme: themeProp, ...props }: ToasterProps) => {
  const { theme: resolvedTheme } = useTheme()
  const theme: NonNullable<ToasterProps['theme']> = (themeProp ??
    resolvedTheme ??
    'system') as NonNullable<ToasterProps['theme']>

  return (
    <div className="contents" data-testid="toast-region">
      <Sonner
        className="toaster group"
        icons={{
          success: <CircleCheckIcon className="size-4" />,
          info: <InfoIcon className="size-4" />,
          warning: <TriangleAlertIcon className="size-4" />,
          error: <OctagonXIcon className="size-4" />,
          loading: (
            <span className="inline-flex size-4 shrink-0 animate-spin items-center justify-center">
              <Loader2Icon
                className="block size-full"
                // Sonner offsets direct SVG icons one pixel to balance its
                // icon slot. This SVG rotates inside a wrapper, so inheriting
                // that offset makes its center orbit the wrapper's center.
                style={{ margin: 0 }}
              />
            </span>
          ),
        }}
        style={
          {
            '--normal-bg': 'var(--popover)',
            '--normal-text': 'var(--popover-foreground)',
            '--normal-border': 'var(--border)',
            '--border-radius': 'var(--radius)',
          } as React.CSSProperties
        }
        theme={theme}
        toastOptions={{
          classNames: {
            toast: 'cn-toast',
          },
        }}
        {...props}
      />
    </div>
  )
}

export { Toaster }
