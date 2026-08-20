/** biome-ignore-all lint/style/noNestedTernary: shadcn */
/** biome-ignore-all lint/suspicious/noArrayIndexKey: shadcn */
import { Slider as SliderPrimitive } from '@base-ui/react/slider'

import { haptics } from '@laborer/ui/lib/haptics'
import { cn } from '@laborer/ui/lib/utils'

function Slider({
  className,
  defaultValue,
  value,
  min = 0,
  max = 100,
  onValueCommitted,
  ...props
}: SliderPrimitive.Root.Props) {
  // Deliberately on commit, not on change: ticking every step of a drag turns
  // into one long continuous vibration, which is the anti-pattern. The thumb
  // landing is the moment that deserves feedback.
  const handleValueCommitted: SliderPrimitive.Root.Props['onValueCommitted'] = (
    committed,
    eventDetails
  ) => {
    haptics.commit()
    onValueCommitted?.(committed, eventDetails)
  }

  const _values = Array.isArray(value)
    ? value
    : Array.isArray(defaultValue)
      ? defaultValue
      : [min, max]

  return (
    <SliderPrimitive.Root
      className={cn('data-vertical:h-full data-horizontal:w-full', className)}
      data-slot="slider"
      defaultValue={defaultValue}
      max={max}
      min={min}
      onValueCommitted={handleValueCommitted}
      thumbAlignment="edge"
      value={value}
      {...props}
    >
      <SliderPrimitive.Control className="relative flex w-full touch-none select-none items-center data-vertical:h-full data-vertical:min-h-40 data-vertical:w-auto data-vertical:flex-col data-disabled:opacity-50">
        <SliderPrimitive.Track
          className="relative grow select-none overflow-hidden rounded-full bg-muted data-horizontal:h-1 data-vertical:h-full data-horizontal:w-full data-vertical:w-1"
          data-slot="slider-track"
        >
          <SliderPrimitive.Indicator
            className="select-none bg-primary data-horizontal:h-full data-vertical:w-full"
            data-slot="slider-range"
          />
        </SliderPrimitive.Track>
        {Array.from({ length: _values.length }, (_, index) => (
          <SliderPrimitive.Thumb
            className="relative block size-3 shrink-0 select-none rounded-full border border-ring bg-white ring-ring/50 transition-[color,box-shadow] after:absolute after:-inset-2 hover:ring-3 focus-visible:outline-hidden focus-visible:ring-3 active:ring-3 disabled:pointer-events-none disabled:opacity-50"
            data-slot="slider-thumb"
            key={index}
          />
        ))}
      </SliderPrimitive.Control>
    </SliderPrimitive.Root>
  )
}

export { Slider }
