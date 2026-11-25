import { createFileRoute } from "@tanstack/react-router";
import { TrashPage } from "@/app/drive/trash/trash-page";
import { SearchParams } from "@/client/search-params";

export const Route = createFileRoute("/_authed/_files/trash")({
  // The order chosen, absent for the most recently deleted first.
  validateSearch: (search): { sort?: string } => ({
    sort: SearchParams.string(search, "sort"),
  }),
  component: function Trash() {
    const { sort } = Route.useSearch();
    return <TrashPage sort={sort} />;
  },
});
