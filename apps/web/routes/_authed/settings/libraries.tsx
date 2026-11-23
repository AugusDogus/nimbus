import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { LibrariesSettings } from "@/app/settings/libraries/libraries-settings";
import { trpc } from "@/lib/trpc";

export const Route = createFileRoute("/_authed/settings/libraries")({
  loader: ({ context }) =>
    context.queryClient.ensureQueryData(trpc.libraries.settings.queryOptions()),
  component: function LibrariesPage() {
    const { data } = useSuspenseQuery(trpc.libraries.settings.queryOptions());
    return <LibrariesSettings state={data} />;
  },
});
