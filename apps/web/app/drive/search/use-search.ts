import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { inferRouterOutputs } from "@trpc/server";
import { useEffect, useMemo, useState } from "react";
import { queryClient, trpcClient } from "@/lib/trpc";
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
 * the same order and continues below them. Each later page continues after
 * the last result shown, so loading more only appends.
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
  const full = useQuery({
    queryKey: ["catalog", "search", query, limit, "full"],
    queryFn: ({ signal }) =>
      trpcClient.catalog.search.query(
        { query, path: "", limit, depth: "full" },
        { signal },
      ),
    enabled: enabled && instantReady,
    staleTime: 5_000,
  });
  // Later pages, for the search they continue. (Plain queries rather than
  // useInfiniteQuery, whose code would join the chunk every page loads.)
  // `base` is when the first page they continue was fetched.
  const [later, setLater] = useState<{
    query: string;
    base: number;
    pages: SearchOutput[];
    loading: boolean;
    error: Error | null;
  }>({ query: "", base: 0, pages: [], loading: false, error: null });
  const own = later.query === query ? later : null;
  const base = full.dataUpdatedAt;
  const first = full.data;
  const loaded = own?.pages.length ?? 0;
  // A change refetches the first page, so the later pages may list items that were trashed,
  // renamed or moved. Fetch the same number of pages again after the new first page, keeping
  // the old ones on screen until the new ones replace them.
  const stale = first !== undefined && loaded > 0 && own?.base !== base;
  useEffect(() => {
    if (!stale) return;
    const controller = new AbortController();
    void (async () => {
      const pages: SearchOutput[] = [];
      let cursor = first.next;
      while (cursor && pages.length < loaded) {
        const page = await trpcClient.catalog.search.query(
          { query, path: "", limit, depth: "full", cursor },
          { signal: controller.signal },
        );
        pages.push(page);
        cursor = page.next;
      }
      return pages;
    })().then(
      (pages) =>
        setLater((previous) =>
          previous.query === query
            ? { query, base, pages, loading: false, error: null }
            : previous,
        ),
      (error: unknown) => {
        if (controller.signal.aborted) return;
        // Results that may be wrong are dropped; Show more loads them again.
        setLater((previous) =>
          previous.query === query
            ? {
                query,
                base,
                pages: [],
                loading: false,
                error:
                  error instanceof Error
                    ? error
                    : new Error(
                        "The results changed and the later ones could not be reloaded. Show more to try again.",
                      ),
              }
            : previous,
        );
      },
    );
    return () => controller.abort();
  }, [stale, first, base, loaded, query, limit]);

  const fullPages = useMemo(
    () => (full.data ? [full.data, ...(own?.pages ?? [])] : undefined),
    [full.data, own?.pages],
  );
  const entries = useMemo(() => {
    if (!enabled) return [];
    if (!fullPages) return instant.data?.entries ?? [];
    // A page continued after the index was compacted may repeat a path.
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

  const last = fullPages?.[fullPages.length - 1];
  const summary = first ?? instant.data;
  const loadMore = () => {
    const cursor = last?.next;
    if (!cursor || own?.loading || stale) return;
    setLater({
      query,
      base,
      pages: own?.pages ?? [],
      loading: true,
      error: null,
    });
    queryClient
      .fetchQuery({
        queryKey: ["catalog", "search", query, limit, "full", cursor],
        queryFn: ({ signal }) =>
          trpcClient.catalog.search.query(
            { query, path: "", limit, depth: "full", cursor },
            { signal },
          ),
        staleTime: 5_000,
      })
      .then(
        (page) =>
          setLater((previous) =>
            previous.query === query && previous.base === base
              ? {
                  ...previous,
                  pages: [...previous.pages, page],
                  loading: false,
                }
              : previous,
          ),
        (error: unknown) =>
          setLater((previous) =>
            previous.query === query
              ? {
                  ...previous,
                  loading: false,
                  error:
                    error instanceof Error
                      ? error
                      : new Error(
                          "More results could not be loaded. The results shown are unchanged; try again.",
                        ),
                }
              : previous,
          ),
      );
  };
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
    loadingMore: (own?.loading ?? false) || stale,
    error: instant.error ?? full.error ?? own?.error ?? null,
    loadMore,
  };
}
