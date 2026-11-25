import { createFileRoute } from "@tanstack/react-router";
import { LibraryPage } from "@/app/drive/library-page";
import { SearchParams } from "@/client/search-params";

export const Route = createFileRoute("/_authed/_files/starred")({
  // The order chosen on the page, absent for its default (see `useListFilters`).
  validateSearch: (search): { sort?: string } => ({
    sort: SearchParams.string(search, "sort"),
  }),
  component: function StarredPage() {
    const { sort } = Route.useSearch();
    return <LibraryPage kind="starred" sort={sort} />;
  },
});
