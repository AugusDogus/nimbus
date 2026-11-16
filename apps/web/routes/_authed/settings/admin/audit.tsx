import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import {
  AuditPage,
  type AuditSearch,
} from "@/app/settings/admin/audit/audit-page";
import { SearchParams } from "@/client/search-params";
import { trpc } from "@/lib/trpc";

export const Route = createFileRoute("/_authed/settings/admin/audit")({
  validateSearch: (search): AuditSearch => ({
    action: SearchParams.string(search, "action"),
    actor: SearchParams.string(search, "actor"),
    from: SearchParams.string(search, "from"),
    to: SearchParams.string(search, "to"),
    before: SearchParams.string(search, "before"),
  }),
  loaderDeps: ({ search }) => search,
  loader: async ({ context, deps }) => {
    const me = await context.queryClient.ensureQueryData(
      trpc.access.me.queryOptions(),
    );
    if (me.isAdmin)
      await context.queryClient.ensureQueryData(
        trpc.audit.list.queryOptions(deps),
      );
  },
  component: function AuditRoute() {
    const search = Route.useSearch();
    const { data: me } = useSuspenseQuery(trpc.access.me.queryOptions());
    if (!me.isAdmin)
      return <p role="alert">Only server administrators can open this page.</p>;
    return <AuditPage search={search} />;
  },
});
