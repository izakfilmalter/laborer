import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/utils.ts";

const buttonVariants = cva(
  "inline-flex h-8 select-none items-center justify-center rounded-lg border px-3 font-semibold text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50",
  {
    defaultVariants: { variant: "outline" },
    variants: {
      variant: {
        outline:
          "border-border bg-surface text-foreground hover:bg-muted active:bg-muted/80",
      },
    },
  }
);

export const Button = ({
  className,
  variant,
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) => (
  <ButtonPrimitive
    className={cn(buttonVariants({ className, variant }))}
    data-slot="button"
    {...props}
  />
);
