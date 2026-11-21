import { createFileRoute, redirect } from "@tanstack/react-router";
import { FilesPageClient } from "@/app/drive/files/files-page-client";
import { preloadFolder } from "@/app/drive/files/folder-route";
import { fileHref } from "@/app/drive/files/types";
import { Landing } from "@/lib/landing";
import { trpc } from "@/lib/trpc";

/** Files: the drive root, or the home folder for an account that reaches nothing outside it. */
export const Route = createFileRoute("/_authed/_files/")({
  beforeLoad: async ({ context }) => {
    // Refreshed behind the answer, so a first grant elsewhere opens the root from then on.
    const me = await context.queryClient.ensureQueryData({
      ...trpc.access.me.queryOptions(),
      revalidateIfStale: true,
    });
    const home = Landing.rootRedirect(me);
    if (home !== null) throw redirect({ href: fileHref(home), replace: true });
  },
  loader: ({ context }) => preloadFolder(context.queryClient, ""),
  component: () => <FilesPageClient />,
});
