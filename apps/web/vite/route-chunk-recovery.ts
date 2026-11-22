import type { Plugin } from "vite";

const routerImport =
  /import\s*\{\s*lazyRouteComponent\s*\}\s*from\s*["']@tanstack\/react-router["'];?/;

/**
 * Route modules as TanStack Router's code splitting leaves them, with its `lazyRouteComponent`
 * replaced by `replacement`'s. The router's own reloads the page when a split route's code
 * fails to load, which would lose an upload, a transfer or unsaved text. Fails when a module
 * uses the router's function in a way this does not recognise, so it never passes unnoticed.
 */
export function rewriteRouteModule(
  code: string,
  id: string,
  replacement: string,
): string | null {
  if (!code.includes("lazyRouteComponent")) return null;
  if (!routerImport.test(code))
    throw new Error(
      `${id} uses lazyRouteComponent without importing it as TanStack Router's code splitting does, so its route code would reload the page when it fails to load. Update vite/route-chunk-recovery.ts for the router plugin's output.`,
    );
  return code.replace(
    routerImport,
    `import { lazyRouteComponent } from ${JSON.stringify(replacement)};`,
  );
}

/** Loads every split route's code through `replacement`; see `rewriteRouteModule`. */
export function routeChunkRecovery(
  routesDirectory: string,
  replacement: string,
): Plugin {
  return {
    name: "nimbus-route-chunk-recovery",
    transform(code, id) {
      const [file = ""] = id.split("?");
      if (!file.startsWith(routesDirectory) || id.includes("tsr-split"))
        return null;
      const rewritten = rewriteRouteModule(code, file, replacement);
      return rewritten === null ? null : { code: rewritten, map: null };
    },
  };
}
