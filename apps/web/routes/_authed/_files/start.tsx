import { createFileRoute, redirect } from "@tanstack/react-router";
import { fileHref } from "@/app/drive/files/types";
import { Landing } from "@/lib/landing";
import { trpc } from "@/lib/trpc";

/** Where signing in without a destination goes: the root or the home, per `Landing`. */
export const Route = createFileRoute("/_authed/_files/start")({
  beforeLoad: async ({ context }) => {
    const me = await context.queryClient.ensureQueryData(
      trpc.access.me.queryOptions(),
    );
    throw redirect({ href: fileHref(Landing.afterSignIn(me)), replace: true });
  },
});
