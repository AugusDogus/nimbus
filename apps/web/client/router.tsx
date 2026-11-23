import {
  createRouter,
  ErrorComponent,
  type ErrorComponentProps,
} from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { CodeLoad, CodeLoadError } from "@/lib/code-load";
import { queryClient } from "@/lib/trpc";
import { SearchParams } from "./search-params";
import { routeTree } from "./route-tree.gen";

/**
 * A route that failed. One whose code is gone because Nimbus was updated opens in full instead
 * (see `CodeLoad.reloadForUpdate`). Otherwise one whose code did not load says so, and the code
 * load notice says why, with Reload: while leaving would lose work, or when the code did not
 * arrive. The layout around it, and anything running there, stays until then.
 */
function RouteError({ error }: ErrorComponentProps) {
  const codeMissing = error instanceof CodeLoadError;
  // Decided once, as the page fails; asking again while the page reloads changes nothing.
  const [reloading] = useState(() => codeMissing && CodeLoad.reloadForUpdate());
  useEffect(() => {
    if (codeMissing && !reloading) CodeLoad.failed(error);
  }, [codeMissing, reloading, error]);
  if (!codeMissing) return <ErrorComponent error={error} />;
  if (reloading) return null;
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

// Once Nimbus was updated, moving to another page, also with Back and Forward, opens it in full
// to run the new build: the address is put in place at once, rather than after this task, and
// reloading opens it. Search changes, such as sorting or a split view's panes, stay on the page.
router.subscribe("onBeforeNavigate", ({ fromLocation, pathChanged }) => {
  if (fromLocation && pathChanged)
    CodeLoad.reloadForUpdate(() => router.history.flush());
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
