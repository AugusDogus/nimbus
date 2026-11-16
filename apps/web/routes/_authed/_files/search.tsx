import { createFileRoute } from "@tanstack/react-router";
import { LibraryPage } from "@/app/drive/library-page";
import { SearchParams } from "@/client/search-params";

export const Route = createFileRoute("/_authed/_files/search")({
  validateSearch: (search): { q?: string } => ({
    q: SearchParams.string(search, "q"),
  }),
  component: function SearchPage() {
    const { q } = Route.useSearch();
    return <LibraryPage kind="search" query={q?.trim() ?? ""} />;
  },
});
