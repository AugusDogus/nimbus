import { lazyRouteComponent as routerLazyRouteComponent } from "@tanstack/react-router";
import { CodeLoad } from "@/lib/code-load";

/**
 * TanStack Router's split route components, loaded through `CodeLoad.load`: a load that may
 * pass is tried again, and one that keeps failing reaches the route's error component as a
 * `CodeLoadError`, which TanStack Router does not answer by reloading the page. Route modules
 * use this in place of the router's own, through `routeChunkRecovery` (see vite.config.ts).
 */
export function lazyRouteComponent<
  T extends Record<string, unknown>,
  TKey extends keyof T = "default",
>(importer: () => Promise<T>, exportName?: TKey) {
  return routerLazyRouteComponent(() => CodeLoad.load(importer), exportName);
}
