import { Skeleton } from "@/components/ui/skeleton";

export function LoadingSkeleton({ view }: { view: "list" | "grid" }) {
  if (view === "grid") {
    return (
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
        {Array.from({ length: 12 }).map((_, i) => (
          <div
            key={i}
            className="flex flex-col gap-2 rounded-xl border bg-card p-3 sm:gap-3 sm:p-4"
          >
            <Skeleton className="h-16 w-full rounded-lg sm:h-24" />
            <Skeleton className="h-3 w-3/4 sm:h-4" />
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-1">
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="flex min-h-12 items-center gap-4 rounded-lg px-4 py-3">
          <Skeleton className="size-6 shrink-0 rounded" />
          <Skeleton className="h-4 flex-1" />
          <Skeleton className="size-8 shrink-0 rounded md:hidden" />
        </div>
      ))}
    </div>
  );
}
