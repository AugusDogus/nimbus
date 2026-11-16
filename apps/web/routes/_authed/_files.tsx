import { createFileRoute, Outlet } from "@tanstack/react-router";
import { FilesShell } from "@/app/drive/files-shell";
import { prefsQueryOptions } from "@/app/drive/files/use-file-preferences";

export const Route = createFileRoute("/_authed/_files")({
  loader: ({ context }) =>
    context.queryClient.ensureQueryData(prefsQueryOptions),
  component: () => (
    <FilesShell>
      <Outlet />
    </FilesShell>
  ),
});
