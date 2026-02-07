import { cookies } from "next/headers";

import { Skeleton } from "@/components/ui/skeleton";

import { LoadingSkeleton } from "./loading-skeleton";

export default async function Loading() {
  const cookieStore = await cookies();
  const view = cookieStore.get("nimbus_view")?.value === "grid" ? "grid" : "list";

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-4 w-4" />
          <Skeleton className="h-4 w-28" />
        </div>
        <div className="flex items-center gap-2">
          <Skeleton className="h-8 w-24" />
          <Skeleton className="h-8 w-20" />
        </div>
      </div>
      <LoadingSkeleton view={view} />
    </>
  );
}
