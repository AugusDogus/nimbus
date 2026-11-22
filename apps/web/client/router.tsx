import {
  createRouter,
  ErrorComponent,
  useRouter,
  type ErrorComponentProps,
} from "@tanstack/react-router";
import { useEffect } from "react";
import { CodeLoad, CodeLoadError } from "@/lib/code-load";
import { queryClient } from "@/lib/trpc";
import { SearchParams } from "./search-params";
import { routeTree } from "./route-tree.gen";

/**
 * A route that failed. One whose code did not load says so; the code load notice says why, and
 * its Try again loads the route again. The layout around it, and anything running there, stays.
 */
function RouteError({ error }: ErrorComponentProps) {
  const router = useRouter();
  const codeMissing = error instanceof CodeLoadError;
  useEffect(() => {
    if (!codeMissing) return;
    CodeLoad.failed(error);
    return CodeLoad.onRetry(() => void router.invalidate());
  }, [codeMissing, error, router]);
  if (!codeMissing) return <ErrorComponent error={error} />;
  return (
    <p className="mx-auto max-w-md p-6 text-center text-pretty text-sm text-muted-foreground">
      This page could not open.
    </p>
  );
}

export const router = createRouter({
  routeTree,
  context: { queryClient },
  // Hovering or focusing a link loads its route code and data. React Query owns data
  // freshness, so the router always asks it rather than keeping its own copy.
  defaultPreload: "intent",
  defaultPreloadStaleTime: 0,
  parseSearch: SearchParams.parse,
  stringifySearch: SearchParams.stringify,
  defaultErrorComponent: RouteError,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
