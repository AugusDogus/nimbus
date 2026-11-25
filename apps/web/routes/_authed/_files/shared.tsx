import { createFileRoute } from "@tanstack/react-router";
import { SharedTab } from "@/app/drive/shared/shared-frame";
import { SharedTabs } from "@/app/drive/shared/shared-tabs";
import { SearchParams } from "@/client/search-params";

export const Route = createFileRoute("/_authed/_files/shared")({
  validateSearch: (search): { tab?: string; sort?: string } => ({
    tab: SearchParams.string(search, "tab"),
    // The order of the files shared with you, absent for its default (see `useListFilters`).
    sort: SearchParams.string(search, "sort"),
  }),
  component: function SharedPage() {
    const { tab, sort } = Route.useSearch();
    return <SharedTabs tab={SharedTab.of(tab)} sort={sort} />;
  },
});
