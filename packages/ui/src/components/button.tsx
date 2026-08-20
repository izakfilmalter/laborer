import { Button as ButtonPrimitive } from '@base-ui/react/button'
import { haptics } from '@laborer/ui/lib/haptics'
import { cn } from '@laborer/ui/lib/utils'
import { cva, type VariantProps } from 'class-variance-authority'
import { Loader2Icon } from 'lucide-react'

const buttonVariants = cva(
  "group/button inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap rounded-lg border border-transparent bg-clip-padding font-medium text-xs outline-none transition-all focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-1 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground [a]:hover:bg-primary/80',
        outline:
          'border-border bg-background hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50',
        secondary:
          'bg-secondary text-secondary-foreground hover:bg-secondary/80 aria-expanded:bg-secondary aria-expanded:text-secondary-foreground',
        ghost:
          'hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:hover:bg-muted/50',
        destructive:
          'bg-destructive/10 text-destructive hover:bg-destructive/20 focus-visible:border-destructive/40 focus-visible:ring-destructive/20 dark:bg-destructive/20 dark:focus-visible:ring-destructive/40 dark:hover:bg-destructive/30',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      size: {
        default:
          'h-8 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2',
        xs: "h-6 gap-1 in-data-[slot=button-group]:rounded-lg rounded-[min(var(--radius-md),10px)] px-2 text-xs has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-7 gap-1 in-data-[slot=button-group]:rounded-lg rounded-[min(var(--radius-md),12px)] px-2.5 has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
        lg: 'h-9 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-3 has-data-[icon=inline-start]:pl-3',
        icon: 'size-8',
        'icon-xs':
          "size-6 in-data-[slot=button-group]:rounded-lg rounded-[min(var(--radius-md),10px)] [&_svg:not([class*='size-'])]:size-3",
        'icon-sm':
          'size-7 in-data-[slot=button-group]:rounded-lg rounded-[min(var(--radius-md),12px)]',
        'icon-lg': 'size-9',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  }
)

interface ButtonProps
  extends ButtonPrimitive.Props,
    VariantProps<typeof buttonVariants> {
  /**
   * Swaps the label for a centred spinner and blocks further clicks. The label
   * stays mounted underneath so the button keeps its width mid-action.
   */
  readonly loading?: boolean | undefined
}

function Button({
  children,
  className,
  variant = 'default',
  size = 'default',
  disabled = false,
  loading = false,
  onClick,
  ...props
}: ButtonProps) {
  const handleClick: typeof onClick = onClick
    ? (event) => {
        if (variant === 'destructive') {
          haptics.heavyImpact()
        } else {
          haptics.buttonTap()
        }
        onClick(event)
      }
    : undefined

  return (
    <ButtonPrimitive
      aria-busy={loading || undefined}
      className={cn(
        buttonVariants({ variant, size, className }),
        loading && 'relative'
      )}
      data-loading={loading || undefined}
      data-slot="button"
      disabled={disabled || loading}
      onClick={handleClick}
      {...props}
    >
      {loading ? (
        <>
          {/* Sized by the variant's own `[&_svg]` rules, so it tracks the button. */}
          <Loader2Icon
            aria-hidden="true"
            className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 animate-spin"
          />
          <span className="inline-flex items-center justify-center gap-[inherit] opacity-30">
            {children}
          </span>
        </>
      ) : (
        children
      )}
    </ButtonPrimitive>
  )
}

export { Button, buttonVariants, type ButtonProps }
