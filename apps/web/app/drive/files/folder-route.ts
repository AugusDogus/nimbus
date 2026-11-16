import type { QueryClient } from "@tanstack/react-query";
import { fileListQueryOptions } from "./use-file-list";
import { needsStats, prefsQueryOptions } from "./use-file-preferences";

/**
 * Starts loading the folder at `path` without waiting for it. The page keeps the previous
 * folder on screen until the listing arrives, and hovering a link runs this ahead of the click.
 */
export async function preloadFolder(queryClient: QueryClient, path: string) {
  const prefs = await queryClient.ensureQueryData(prefsQueryOptions);
  void queryClient.prefetchQuery(fileListQueryOptions(path, needsStats(prefs)));
}
