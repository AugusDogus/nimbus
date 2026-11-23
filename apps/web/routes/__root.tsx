import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, Outlet } from "@tanstack/react-router";
import { PageNotFound } from "@/components/page-not-found";
import { CodeLoad } from "@/lib/code-load";

export type RouterContext = { queryClient: QueryClient };

export const Route = createRootRouteWithContext<RouterContext>()({
  // While the page reloads to open the next one in full, the current one stays as it is.
  beforeLoad: () => CodeLoad.reloading(),
  component: Outlet,
  notFoundComponent: PageNotFound,
});
