import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { McpSettings } from "@/app/settings/mcp/mcp-settings";
import { trpc } from "@/lib/trpc";

export const Route = createFileRoute("/_authed/settings/mcp")({
  loader: ({ context }) =>
    context.queryClient.ensureQueryData(trpc.mcp.settings.queryOptions()),
  component: function McpPage() {
    const { data, dataUpdatedAt } = useSuspenseQuery(
      trpc.mcp.settings.queryOptions(),
    );
    // The settings keep their own list while disconnecting; fresh data starts it over.
    return <McpSettings key={dataUpdatedAt} state={data} />;
  },
});
