import { cn } from "@/lib/utils";

/**
 * A touch-friendly button for use inside Drawer action lists.
 * Provides consistent 48px+ touch targets across all drawers.
 */
export function DrawerActionItem({
  className,
  ...props
}: React.ComponentProps<"button">) {
  return (
    <button
      type="button"
      className={cn(
        "flex min-h-12 items-center gap-3 rounded-lg px-3 text-left text-sm hover:bg-accent active:bg-accent",
        className,
      )}
      {...props}
    />
  );
}
