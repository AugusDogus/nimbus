import { createFileRoute, Outlet } from "@tanstack/react-router";
import { FilesShell } from "@/app/drive/files-shell";
import { prefsQueryOptions } from "@/app/drive/files/use-file-preferences";
import { trpc } from "@/lib/trpc";

export const Route = createFileRoute("/_authed/_files")({
  // The account's top folder roots the breadcrumb. Pages from the server carry both answers.
  loader: ({ context }) =>
    Promise.all([
      context.queryClient.ensureQueryData(prefsQueryOptions),
      context.queryClient.ensureQueryData(trpc.access.me.queryOptions()),
    ]),
  component: () => (
    <FilesShell>
      <Outlet />
    </FilesShell>
  ),
});
