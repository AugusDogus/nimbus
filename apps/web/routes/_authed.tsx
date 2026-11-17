import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { UploadProvider } from "@/components/upload-provider";
import { sessionQuery } from "@/lib/session-query";

/** Signed-in pages. Signed-out visitors go to the sign-in page. */
export const Route = createFileRoute("/_authed")({
  beforeLoad: async ({ context, location }) => {
    const session = await context.queryClient.ensureQueryData(sessionQuery);
    // Sign-in returns to the page asked for; it validates `callbackURL` itself.
    if (!session)
      throw redirect({
        to: "/login",
        search: location.href === "/" ? {} : { callbackURL: location.href },
      });
    return { session };
  },
  component: () => (
    <UploadProvider>
      <Outlet />
    </UploadProvider>
  ),
});
