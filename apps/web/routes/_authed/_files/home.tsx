import { createFileRoute, redirect } from "@tanstack/react-router";
import { fileHref } from "@/app/drive/files/types";
import { trpc } from "@/lib/trpc";

/** "My files" opens the account's home folder, or the drive when it has none. */
export const Route = createFileRoute("/_authed/_files/home")({
  beforeLoad: async ({ context }) => {
    const { home } = await context.queryClient.ensureQueryData(
      trpc.access.me.queryOptions(),
    );
    throw redirect({ href: fileHref(home ?? ""), replace: true });
  },
});
