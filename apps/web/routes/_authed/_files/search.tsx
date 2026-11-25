import { createFileRoute } from "@tanstack/react-router";
import { SearchResultsPage } from "@/app/drive/search/search-results-page";
import {
  validateSplitSearch,
  type SplitSearch,
} from "@/app/drive/files/split-search";
import { SearchParams } from "@/client/search-params";

export const Route = createFileRoute("/_authed/_files/search")({
  // Searched from a split view, results keep it: `left` and the split params (see
  // `useCarriedSplit`), so a folder opened from them opens in the active pane.
  validateSearch: (
    search,
  ): { q?: string; left?: string; sort?: string } & SplitSearch => ({
    q: SearchParams.string(search, "q"),
    left: SearchParams.string(search, "left"),
    // The order chosen, absent for relevance (see `useListFilters`).
    sort: SearchParams.string(search, "sort"),
    ...validateSplitSearch(search),
  }),
  component: function SearchPage() {
    const { q, sort } = Route.useSearch();
    return <SearchResultsPage query={q?.trim() ?? ""} sort={sort} />;
  },
});
