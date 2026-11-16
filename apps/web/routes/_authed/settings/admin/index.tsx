import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { AdminSettings } from "@/app/settings/admin/admin-settings";
import { BackupSettings } from "@/app/settings/admin/backup-settings";
import { trpc } from "@/lib/trpc";

export const Route = createFileRoute("/_authed/settings/admin/")({
  component: function AdminPage() {
    const { data: me } = useSuspenseQuery(trpc.access.me.queryOptions());
    if (!me.isAdmin)
      return <p role="alert">Only server administrators can open this page.</p>;
    return (
      <div className="space-y-8">
        <AdminSettings />
        <BackupSettings />
      </div>
    );
  },
});
