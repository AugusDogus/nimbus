import { createRouter } from "@tanstack/react-router";
import { queryClient } from "@/lib/trpc";
import { SearchParams } from "./search-params";
import { routeTree } from "./route-tree.gen";

export const router = createRouter({
  routeTree,
  context: { queryClient },
  // Hovering or focusing a link loads its route code and data. React Query owns data
  // freshness, so the router always asks it rather than keeping its own copy.
  defaultPreload: "intent",
  defaultPreloadStaleTime: 0,
  parseSearch: SearchParams.parse,
  stringifySearch: SearchParams.stringify,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
