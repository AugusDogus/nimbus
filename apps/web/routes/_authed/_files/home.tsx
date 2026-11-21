import { createFileRoute, redirect } from "@tanstack/react-router";
import { fileHref } from "@/app/drive/files/types";
import { trpc } from "@/lib/trpc";

/** The account's home folder, or the drive root when it has none. Old links and bookmarks use it. */
export const Route = createFileRoute("/_authed/_files/home")({
  beforeLoad: async ({ context }) => {
    const { home } = await context.queryClient.ensureQueryData(
      trpc.access.me.queryOptions(),
    );
    throw redirect({ href: fileHref(home ?? ""), replace: true });
  },
});
