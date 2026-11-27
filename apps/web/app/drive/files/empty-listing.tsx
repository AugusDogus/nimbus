import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

/**
 * A listing with nothing in it, on every files page: the page's icon, what is empty, and what
 * puts something there, such as a hint or a way back to the drive.
 */
export function EmptyListing({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon: LucideIcon;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-20 text-center">
      <div className="mb-4 flex size-16 items-center justify-center rounded-full bg-muted">
        <Icon className="size-8 text-muted-foreground" />
      </div>
      <h3 className="text-balance text-lg font-medium">{title}</h3>
      {description && (
        <p className="text-pretty mt-1 text-sm text-muted-foreground">
          {description}
        </p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
