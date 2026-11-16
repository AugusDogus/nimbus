import { createFileRoute, Outlet } from "@tanstack/react-router";
import { SettingsShell } from "@/app/settings/settings-shell";
import { trpc } from "@/lib/trpc";

export const Route = createFileRoute("/_authed/settings")({
  loader: ({ context }) =>
    context.queryClient.ensureQueryData(trpc.access.me.queryOptions()),
  component: function SettingsLayout() {
    const me = Route.useLoaderData();
    return (
      <SettingsShell isAdmin={me.isAdmin}>
        <Outlet />
      </SettingsShell>
    );
  },
});
