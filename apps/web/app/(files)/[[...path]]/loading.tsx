import { cookies } from "next/headers";

import { Skeleton } from "@/components/ui/skeleton";

import { LoadingSkeleton } from "./loading-skeleton";

export default async function Loading() {
  const cookieStore = await cookies();
  const view = cookieStore.get("nimbus_view")?.value === "grid" ? "grid" : "list";

  return (
    <>
      <div className="mb-2 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 px-4 md:mb-4 md:flex md:justify-between md:px-0">
        <div className="min-w-0 overflow-hidden">
          <div className="flex items-center gap-2">
            {/* Mobile breadcrumb shape: home + sep + current */}
            <Skeleton className="size-8 shrink-0 rounded md:hidden" />
            <Skeleton className="h-4 w-3 shrink-0 md:hidden" />
            <Skeleton className="h-4 w-28 max-w-[38vw] md:hidden" />

            {/* Desktop breadcrumb shape: My Drive > ... > Parent > Current */}
            <div className="hidden items-center gap-2 md:flex">
              <Skeleton className="h-4 w-16" />
              <Skeleton className="h-4 w-3 shrink-0" />
              <Skeleton className="size-6 rounded" />
              <Skeleton className="h-4 w-3 shrink-0" />
              <Skeleton className="h-4 w-20" />
              <Skeleton className="h-4 w-3 shrink-0" />
              <Skeleton className="h-4 w-24" />
            </div>
          </div>
        </div>

        <div className="ml-auto flex shrink-0 items-center gap-2">
          {/* Mobile filters: filter button + list/grid toggle */}
          <Skeleton className="size-8 rounded md:hidden" />
          <Skeleton className="size-8 rounded md:hidden" />
          <Skeleton className="size-8 rounded md:hidden" />

          {/* Desktop filters: sort, group toggle, list/grid toggle */}
          <div className="hidden items-center gap-2 md:flex">
            <Skeleton className="h-8 w-36 rounded" />
            <Skeleton className="size-8 rounded" />
            <Skeleton className="h-8 w-16 rounded" />
          </div>
        </div>
      </div>
      <LoadingSkeleton view={view} />
    </>
  );
}
