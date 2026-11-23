import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import type { StorageSummary } from "./use-file-storage";

const progressClass =
  "*:data-[slot=progress-track]:h-1.5 *:data-[slot=progress-track]:bg-foreground/10 [&_[data-slot=progress-indicator]]:bg-foreground/80";

/** A line of text still to come: the line's own height, with a bar `width` wide in it. */
function Pending({ width }: { width: string }) {
  return (
    <span className="flex h-4 items-center">
      {/* Darker than other bars, to show on the sidebar's tint as on the card. */}
      <Skeleton
        className={cn("h-3 bg-foreground/10 motion-reduce:animate-none", width)}
      />
    </span>
  );
}

/**
 * The storage summary at the foot of the sidebar. While it loads it keeps the shape it will
 * have, so the sidebar's footer, and the page's skeleton that shows this same state, never move
 * when the numbers arrive.
 */
export function StorageIndicator({ storage }: { storage: StorageSummary }) {
  const capacity = storage.status === "ready" ? storage.capacity : null;
  const loading = storage.status === "loading";

  return (
    <section
      aria-label="Storage usage"
      data-shape="storage"
      aria-busy={loading || undefined}
      className="overflow-hidden rounded-xl bg-sidebar-accent/50 group-data-[collapsible=icon]:hidden"
    >
      <div className="space-y-3 rounded-xl bg-background/80 p-3">
        <div className="flex items-center justify-between gap-2 text-sm">
          <span className="font-medium text-foreground">
            {capacity || loading ? "Disk storage" : "Storage"}
          </span>
          {capacity && (
            <span className="text-xs tabular-nums text-muted-foreground">
              {capacity.usedPercent}% used
            </span>
          )}
          {loading && <Pending width="w-12" />}
        </div>
        {capacity ? (
          <>
            <Progress
              aria-label="Disk storage used"
              value={capacity.usedPercent}
              className={progressClass}
            />
            <p className="text-xs tabular-nums text-muted-foreground">
              {capacity.availableLabel} free of {capacity.totalLabel}
            </p>
          </>
        ) : loading ? (
          <>
            <Progress aria-hidden value={0} className={progressClass} />
            {/* Not a paragraph: the bar is a block, which would end one early in the server's
                markup for the page's skeleton. */}
            <div role="status" className="relative">
              <span className="sr-only">Calculating storage…</span>
              <Pending width="w-28" />
            </div>
          </>
        ) : (
          <p role="status" className="text-xs text-muted-foreground">
            {storage.status === "ready"
              ? "Disk capacity unavailable"
              : "Storage unavailable. Try again shortly."}
          </p>
        )}
      </div>
      {(storage.status === "ready" || loading) && (
        <div className="flex items-center justify-between gap-2 px-3 py-2.5 text-xs text-muted-foreground">
          <span>Nimbus files</span>
          {storage.status === "ready" ? (
            <span className="tabular-nums">{storage.usedLabel}</span>
          ) : (
            <Pending width="w-8" />
          )}
        </div>
      )}
    </section>
  );
}
