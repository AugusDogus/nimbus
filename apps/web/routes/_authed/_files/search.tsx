import { createFileRoute } from "@tanstack/react-router";
import { SearchResultsPage } from "@/app/drive/search/search-results-page";
import { SearchParams } from "@/client/search-params";

export const Route = createFileRoute("/_authed/_files/search")({
  validateSearch: (search): { q?: string } => ({
    q: SearchParams.string(search, "q"),
  }),
  component: function SearchPage() {
    const { q } = Route.useSearch();
    return <SearchResultsPage query={q?.trim() ?? ""} />;
  },
});
