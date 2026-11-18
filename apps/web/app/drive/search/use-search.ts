import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { inferRouterOutputs } from "@trpc/server";
import { useEffect, useMemo, useRef, useState } from "react";
import { trpcClient } from "@/lib/trpc";
import type { WebRouter } from "@/server/web-router";
import { SearchPages, type LaterPages } from "./search-pages";
import { SearchProblem } from "./search-problem";

type SearchOutput = inferRouterOutputs<WebRouter>["catalog"]["search"];
export type SearchResultEntry = SearchOutput["entries"][number];

/** Fetches the full-depth page after `cursor`. */
const pageAfter =
  (query: string, limit: number, signal?: AbortSignal) => (cursor: string) =>
    trpcClient.catalog.search.query(
      { query, path: "", limit, depth: "full", cursor },
      { signal },
    );

/**
 * A search the server refused or stopped for pacing is not retried at once, which would only
 * add to the load; the page offers to search again. Other failures retry as usual.
 */
const retryable = (failures: number, error: unknown) =>
  SearchProblem.of(error).kind === "failed" && failures < 3;

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
  /**
   * The search changed while paging (a restart), so the list was rebuilt from a fresh first
   * page. Said until the next page is asked for.
   */
  restarted: boolean;
  /** Why the search, or the last page asked for, has no answer. */
  problem: SearchProblem | null;
  /** Asks again for what failed. */
  retry: () => void;
  loadMore: () => void;
};

/**
 * A search in two steps: names containing the query come back first (the
 * instant layer), then every layer, which starts with those same results in
 * the same order and continues below them. Each later page continues after
 * the last result shown, unless the server cannot continue it: then it sends a
 * fresh first page (a restart), which replaces the list.
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
    retry: retryable,
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
    retry: retryable,
  });
  // Later pages, for the search they continue. (Plain queries rather than
  // useInfiniteQuery, whose code would join the chunk every page loads.)
  // `base` is when the first page they continue was fetched.
  const [later, setLater] = useState<
    LaterPages<SearchOutput> & {
      query: string;
      base: number;
      loading: boolean;
      error: unknown;
      /** The last fill met a restart and rebuilt the list from a fresh first page. */
      restarted: boolean;
    }
  >({
    ...SearchPages.none,
    query: "",
    base: 0,
    loading: false,
    error: null,
    restarted: false,
  });
  const own = later.query === query ? later : null;
  const base = full.dataUpdatedAt;
  const first = full.data;
  const shown = useMemo(
    () => (first ? SearchPages.shown(first, own ?? SearchPages.none) : []),
    [first, own],
  );
  // One fill at a time: a newer one (paging, or reloading after a change) cancels the older,
  // so an answer that arrives late never overwrites newer results.
  const operation = useRef<AbortController | null>(null);
  useEffect(() => () => operation.current?.abort(), []);
  // A change refetches the first page, so the later pages may list items that were trashed,
  // renamed or moved. Fetch as many pages again after the new first page, keeping the old ones
  // on screen until the new ones replace them.
  const loaded = shown.length;
  const stale =
    first !== undefined &&
    own !== null &&
    (own.head !== null || own.pages.length > 0) &&
    own.base !== base;
  useEffect(() => {
    if (!stale) return;
    operation.current?.abort();
    const controller = new AbortController();
    operation.current = controller;
    void SearchPages.fill(
      first,
      SearchPages.none,
      loaded,
      pageAfter(query, limit, controller.signal),
    ).then((filled) => {
      if (controller.signal.aborted) return;
      // Pages after the new first page, as far as they loaded; a failure is said with them.
      setLater((previous) =>
        previous.query === query
          ? { ...filled, query, base, loading: false }
          : previous,
      );
    });
    return () => controller.abort();
  }, [stale, first, base, loaded, query, limit]);

  const entries = useMemo(() => {
    if (!enabled) return [];
    if (!first) return instant.data?.entries ?? [];
    return SearchPages.entries(shown);
  }, [enabled, first, shown, instant.data]);

  const last = shown.at(-1);
  // After a restart the fresh first page counts every match as the search stands now.
  const summary = own?.head ?? first ?? instant.data;
  const loadMore = () => {
    if (!first || !last?.next || own?.loading || stale) return;
    const current = own ?? SearchPages.none;
    operation.current?.abort();
    const controller = new AbortController();
    operation.current = controller;
    setLater({
      ...current,
      query,
      base,
      loading: true,
      error: null,
      restarted: false,
    });
    // One page more than shown; a restart rebuilds from a fresh first page to as many pages.
    void SearchPages.fill(
      first,
      current,
      shown.length + 1,
      pageAfter(query, limit, controller.signal),
    ).then((filled) => {
      if (controller.signal.aborted) return;
      setLater((previous) =>
        previous.query === query
          ? { ...filled, query, base, loading: false }
          : previous,
      );
    });
  };
  const failure = instant.error ?? full.error ?? own?.error ?? null;
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
    restarted: own?.restarted ?? false,
    problem: failure === null ? null : SearchProblem.of(failure),
    retry: () => {
      if (instant.isError) void instant.refetch();
      else if (full.isError) void full.refetch();
      else loadMore();
    },
    loadMore,
  };
}
