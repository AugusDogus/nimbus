import { createFileRoute } from "@tanstack/react-router";
import { SharedTabs } from "@/app/drive/shared/shared-tabs";
import { SearchParams } from "@/client/search-params";

export const Route = createFileRoute("/_authed/_files/shared")({
  validateSearch: (search): { tab?: string } => ({
    tab: SearchParams.string(search, "tab"),
  }),
  component: function SharedPage() {
    const { tab } = Route.useSearch();
    return (
      <div className="space-y-6">
        <h1 className="text-balance text-2xl font-semibold">Shared</h1>
        <SharedTabs
          tab={tab === "links" || tab === "requests" ? tab : "with-me"}
        />
      </div>
    );
  },
});
