import { useEffect, useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Placeholder entries while a folder's listing loads. After `delayMs`, so a listing that arrives
 * quickly never flashes them.
 */
export function LoadingSkeleton({
  view,
  delayMs = 0,
}: {
  view: "list" | "grid";
  delayMs?: number;
}) {
  const [due, setDue] = useState(delayMs === 0);
  useEffect(() => {
    if (due) return;
    const timer = setTimeout(() => setDue(true), delayMs);
    return () => clearTimeout(timer);
  }, [due, delayMs]);
  if (!due) return null;
  if (view === "grid") {
    // The grid's own rule (see `EntryLayout.gridTrack`): landscape cards at least 160 px wide.
    return (
      <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-3">
        {Array.from({ length: 12 }).map((_, i) => (
          <div
            key={i}
            className="flex aspect-[4/3] flex-col overflow-hidden rounded-lg border"
          >
            <div className="flex min-h-0 flex-1 items-center justify-center bg-muted/40">
              <Skeleton className="size-10 rounded" />
            </div>
            <div className="flex h-9 shrink-0 items-center justify-center px-3">
              <Skeleton className="h-3 w-3/4" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-1">
      {Array.from({ length: 8 }).map((_, i) => (
        <div
          key={i}
          className="group/entry flex min-h-12 cursor-default items-center gap-4 rounded-lg px-4 py-3"
        >
          <Skeleton className="size-6 shrink-0 rounded" />
          <Skeleton className="h-4 flex-1" />
          <Skeleton className="size-8 shrink-0 rounded md:hidden" />
        </div>
      ))}
    </div>
  );
}
