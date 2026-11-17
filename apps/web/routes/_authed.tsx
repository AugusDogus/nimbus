import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { UploadProvider } from "@/components/upload-provider";
import { sessionQuery } from "@/lib/session-query";

/** Signed-in pages. Signed-out visitors go to the sign-in page. */
export const Route = createFileRoute("/_authed")({
  beforeLoad: async ({ context }) => {
    const session = await context.queryClient.ensureQueryData(sessionQuery);
    if (!session) throw redirect({ to: "/login" });
    return { session };
  },
  component: () => (
    <UploadProvider>
      <Outlet />
    </UploadProvider>
  ),
});
