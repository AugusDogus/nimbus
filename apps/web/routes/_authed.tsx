import { lazy, Suspense } from "react";
import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { UploadProvider } from "@/components/upload-provider";
import { sessionQuery } from "@/lib/session-query";

const ImpersonationBanner = lazy(
  () => import("@/components/impersonation-banner"),
);

/** Signed-in pages. Signed-out visitors go to the sign-in page. */
export const Route = createFileRoute("/_authed")({
  beforeLoad: async ({ context }) => {
    const session = await context.queryClient.ensureQueryData(sessionQuery);
    if (!session) throw redirect({ to: "/login" });
    return { session };
  },
  component: Authed,
});

function Authed() {
  const { session } = Route.useRouteContext();
  return (
    <UploadProvider>
      {session.impersonatedBy !== null && (
        <Suspense fallback={null}>
          <ImpersonationBanner email={session.user.email} />
        </Suspense>
      )}
      <Outlet />
    </UploadProvider>
  );
}
