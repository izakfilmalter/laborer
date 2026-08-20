import { Collapsible as CollapsiblePrimitive } from '@base-ui/react/collapsible'
import { haptics } from '@laborer/ui/lib/haptics'

function Collapsible({
  onOpenChange,
  ...props
}: CollapsiblePrimitive.Root.Props) {
  const handleOpenChange: CollapsiblePrimitive.Root.Props['onOpenChange'] = (
    open,
    eventDetails
  ) => {
    if (open) {
      haptics.expand()
    } else {
      haptics.collapse()
    }
    onOpenChange?.(open, eventDetails)
  }

  return (
    <CollapsiblePrimitive.Root
      data-slot="collapsible"
      onOpenChange={handleOpenChange}
      {...props}
    />
  )
}

function CollapsibleTrigger({ ...props }: CollapsiblePrimitive.Trigger.Props) {
  return (
    <CollapsiblePrimitive.Trigger data-slot="collapsible-trigger" {...props} />
  )
}

function CollapsibleContent({ ...props }: CollapsiblePrimitive.Panel.Props) {
  return (
    <CollapsiblePrimitive.Panel data-slot="collapsible-content" {...props} />
  )
}

export { Collapsible, CollapsibleTrigger, CollapsibleContent }
