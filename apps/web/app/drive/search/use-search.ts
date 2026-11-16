import {
  keepPreviousData,
  useInfiniteQuery,
  useQuery,
} from "@tanstack/react-query";
import type { inferRouterOutputs } from "@trpc/server";
import { useMemo } from "react";
import { trpcClient } from "@/lib/trpc";
import type { WebRouter } from "@/server/web-router";

type SearchOutput = inferRouterOutputs<WebRouter>["catalog"]["search"];
export type SearchResultEntry = SearchOutput["entries"][number];

/** Results and counts, as far as the search has got. */
export type SearchState = {
  entries: SearchResultEntry[];
  /** Matches found so far; `exact` once every layer has run. */
  total: { count: number; exact: boolean } | null;
  /** More results exist than are loaded. */
  more: boolean;
  /** False while the server's first crawl after starting is still running. */
  complete: boolean;
  /** Nothing to show yet: the first answer has not arrived. */
  pending: boolean;
  /** Every layer has answered, so an empty list really means no matches. */
  settled: boolean;
  loadingMore: boolean;
  error: Error | null;
  loadMore: () => void;
};

/**
 * A search in two steps: names containing the query come back first (the
 * instant layer), then every layer, which starts with those same results in
 * the same order and continues below them. Later pages come from the list the
 * server ranked for the first one, so loading more only appends.
 */
export function useSearch(query: string, limit: number): SearchState {
  const enabled = query.length > 0;
  const instant = useQuery({
    queryKey: ["catalog", "search", query, limit, "instant"],
    queryFn: ({ signal }) =>
      trpcClient.catalog.search.query(
        { query, path: "", limit, depth: "instant" },
        { signal },
      ),
    enabled,
    placeholderData: keepPreviousData,
    staleTime: 5_000,
  });
  // Waits for the instant answer, so the two are separate requests and the
  // fast one is never held back by the slow one in a batch.
  const instantReady = instant.isSuccess && !instant.isPlaceholderData;
  const full = useInfiniteQuery({
    queryKey: ["catalog", "search", query, limit, "full"],
    queryFn: ({ signal, pageParam }) =>
      trpcClient.catalog.search.query(
        { query, path: "", limit, depth: "full", offset: pageParam },
        { signal },
      ),
    initialPageParam: 0,
    getNextPageParam: (last) => last.next ?? undefined,
    enabled: enabled && instantReady,
    staleTime: 5_000,
  });

  const fullPages = full.data?.pages;
  const entries = useMemo(() => {
    if (!enabled) return [];
    if (!fullPages) return instant.data?.entries ?? [];
    // A page computed again after the server dropped its list may repeat a path.
    const seen = new Set<string>();
    const merged: SearchResultEntry[] = [];
    for (const page of fullPages)
      for (const entry of page.entries)
        if (!seen.has(entry.path)) {
          seen.add(entry.path);
          merged.push(entry);
        }
    return merged;
  }, [enabled, fullPages, instant.data]);

  const first = fullPages?.[0];
  const last = fullPages?.[fullPages.length - 1];
  const summary = first ?? instant.data;
  return {
    entries,
    total:
      enabled && summary
        ? { count: summary.total, exact: first !== undefined }
        : null,
    more: last ? last.next !== null : (instant.data?.truncated ?? false),
    complete: summary?.complete ?? true,
    pending: enabled && instant.isPending,
    settled: !enabled || first !== undefined || full.isError || instant.isError,
    loadingMore: full.isFetchingNextPage,
    error: instant.error ?? full.error,
    loadMore: () => {
      if (full.hasNextPage && !full.isFetchingNextPage)
        void full.fetchNextPage();
    },
  };
}
