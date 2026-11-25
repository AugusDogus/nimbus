import { PageLayout } from "@/components/page-layout";
import { Button, type ButtonProps } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import type { FiltersRowProps } from "../files/filters-row";
import { TrashOrder } from "./trash-order";

/**
 * Trash's parts, which the page and its skeletons share, so a skeleton keeps step with the items
 * that replace it.
 */
export const TrashShape = {
  header: "flex flex-wrap items-start justify-between gap-3",
  /** The header's end: the sort control, then Empty trash. */
  tools: "flex shrink-0 items-center gap-2",
  list: "divide-y rounded-lg border",
  item: "flex flex-wrap items-center gap-3 p-4",
  itemText: "min-w-0 flex-1 basis-60",
  path: "truncate text-sm font-medium",
  dates: "mt-1 text-xs tabular-nums text-muted-foreground",
  emptyLabel: "Empty trash",
} as const;

/**
 * Trash's sort control, choosing with `choose`: a folder's, with Trash's own orders, and no view
 * or grouping (see `TrashOrder`).
 */
export function trashFilters(
  sort: string | undefined,
  choose: (sort: string | undefined) => void,
): FiltersRowProps {
  return {
    sort: {
      choices: TrashOrder.all,
      value: TrashOrder.pick(sort).value,
      onChange: (value) => choose(TrashOrder.param(TrashOrder.pick(value))),
    },
    view: null,
    group: null,
  };
}

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

/**
 * A button still to come: the button itself, so it takes the size its `label` gives it, drawn
 * as a placeholder (its fill, on the button's inner layer, greyed and its label hidden).
 */
export function PendingButton({
  label,
  variant,
}: {
  label: string;
  variant: ButtonProps["variant"];
}) {
  return (
    <Button
      aria-hidden
      tabIndex={-1}
      variant={variant}
      size="compact"
      className={cn(
        "pointer-events-none animate-pulse text-transparent [&>span:first-child]:bg-accent [&>span:first-child]:shadow-none",
        bar,
      )}
    >
      {label}
    </Button>
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
            {/* The dates' own line, which wraps where theirs does, a bar under each line. */}
            <p className={TrashShape.dates}>
              <span
                className={cn(
                  "animate-pulse rounded bg-accent text-transparent [box-decoration-break:clone]",
                  bar,
                )}
              >
                Deleted 00/00/0000 · Expires 00/00/0000
              </span>
            </p>
          </div>
          <PendingButton label="Restore" variant="tertiary" />
          <PendingButton label="Delete permanently" variant="ghost" />
        </li>
      ))}
    </ul>
  );
}
