import type { VariantProps } from "class-variance-authority";
import { PageLayout } from "@/components/page-layout";
import { buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/**
 * Trash's parts, which the page and its skeletons share, so a skeleton keeps step with the items
 * that replace it.
 */
export const TrashShape = {
  header: "flex flex-wrap items-start justify-between gap-3",
  list: "divide-y rounded-lg border",
  item: "flex flex-wrap items-center gap-3 p-4",
  itemText: "min-w-0 flex-1 basis-60",
  path: "truncate text-sm font-medium",
  dates: "mt-1 text-xs tabular-nums text-muted-foreground",
  emptyLabel: "Empty trash",
} as const;

/** Trash's title and what it keeps, the same before and after it loads. */
export function TrashIntro() {
  return (
    <div className="min-w-0 flex-1">
      <h1 className={PageLayout.title}>Trash</h1>
      <p className="text-pretty mt-2 text-sm text-muted-foreground">
        Items are kept for 30 days. Restoring an item brings back its share
        links and direct permissions.
      </p>
    </div>
  );
}

const bar = "motion-reduce:animate-none";

/** A button still to come, the size its `label` will give it. */
export function PendingButton({
  label,
  variant,
}: {
  label: string;
  variant: VariantProps<typeof buttonVariants>["variant"];
}) {
  return (
    <span
      aria-hidden
      className={cn(
        buttonVariants({ variant, size: "compact" }),
        "pointer-events-none animate-pulse border-transparent bg-accent text-transparent shadow-none hover:bg-accent dark:bg-accent",
        bar,
      )}
    >
      {label}
    </span>
  );
}

/** Trash's items before they arrive: the shape of a few, buttons included. */
export function TrashSkeleton() {
  return (
    <ul aria-hidden className={TrashShape.list}>
      {Array.from({ length: 3 }, (_, index) => (
        <li key={index} data-trash-placeholder className={TrashShape.item}>
          <div className={TrashShape.itemText}>
            <div className="flex h-5 items-center">
              <Skeleton className={cn("h-3.5 w-48 max-w-full", bar)} />
            </div>
            <div className="mt-1 flex h-4 items-center">
              <Skeleton className={cn("h-3 w-56 max-w-full", bar)} />
            </div>
          </div>
          <PendingButton label="Restore" variant="tertiary" />
          <PendingButton label="Delete permanently" variant="ghost" />
        </li>
      ))}
    </ul>
  );
}
