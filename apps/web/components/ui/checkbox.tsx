import * as React from "react"
import { CheckIcon } from "lucide-react"

import { cn } from "@/lib/utils"

/**
 * A native checkbox styled like the other form controls. The platform input
 * provides keyboard, form and accessibility behavior with no script.
 */
function Checkbox({
  className,
  onCheckedChange,
  onChange,
  ...props
}: Omit<React.ComponentProps<"input">, "type"> & {
  onCheckedChange?: (checked: boolean) => void
}) {
  return (
    <span data-slot="checkbox" className={cn("relative inline-grid size-4 shrink-0 place-items-center", className)}>
      <input
        type="checkbox"
        className="peer border-input dark:bg-input/30 checked:bg-primary checked:border-primary focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive size-4 appearance-none rounded-[4px] border shadow-xs transition-shadow outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50"
        onChange={(event) => {
          onChange?.(event)
          onCheckedChange?.(event.target.checked)
        }}
        {...props}
      />
      <CheckIcon
        aria-hidden
        className="text-primary-foreground pointer-events-none invisible absolute size-3.5 peer-checked:visible"
      />
    </span>
  )
}

export { Checkbox }
