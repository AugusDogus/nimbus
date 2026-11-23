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
    return (
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
        {Array.from({ length: 12 }).map((_, i) =>
          i % 2 === 0 ? (
            <div
              key={i}
              className="group/entry relative flex cursor-default flex-col rounded-xl border bg-card"
            >
              <div className="flex h-20 items-center justify-center rounded-t-xl bg-muted sm:h-28">
                <Skeleton className="size-8 rounded sm:size-10" />
              </div>
              <div className="border-t p-2 sm:p-3">
                <Skeleton className="h-3 w-5/6 sm:h-4" />
              </div>
            </div>
          ) : (
            <div
              key={i}
              className="group/entry relative flex flex-col items-center justify-center gap-2 rounded-xl border bg-muted/50 p-3 sm:gap-3 sm:p-4"
            >
              <Skeleton className="size-10 rounded-full sm:size-12" />
              <Skeleton className="h-3 w-full sm:h-4" />
            </div>
          ),
        )}
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
