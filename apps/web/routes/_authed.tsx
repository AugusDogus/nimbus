import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { UploadProvider } from "@/components/upload-provider";
import { CallbackUrl } from "@/lib/callback-url";
import { sessionQuery } from "@/lib/session-query";

/** Signed-in pages. Signed-out visitors go to the sign-in page. */
export const Route = createFileRoute("/_authed")({
  beforeLoad: async ({ context, location }) => {
    const session = await context.queryClient.ensureQueryData(sessionQuery);
    if (!session)
      throw redirect({ href: CallbackUrl.signInPath(location.href) });
    return { session };
  },
  component: () => (
    <UploadProvider>
      <Outlet />
    </UploadProvider>
  ),
});
