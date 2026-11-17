import { useQuery } from "@tanstack/react-query";
import { sessionQuery } from "@/lib/session-query";
import ImpersonationBanner from "./impersonation-banner";
import { Toaster } from "./toaster";

/**
 * UI the app loads after its first render, so no page's first load carries it: the toast
 * area, and the banner shown while an administrator is signed in as someone else.
 */
export function AfterStart() {
  // Only reads the session the signed-in pages already loaded; never fetches it.
  const { data: session } = useQuery({ ...sessionQuery, enabled: false });
  return (
    <>
      <Toaster />
      {session?.impersonatedBy && (
        <ImpersonationBanner email={session.user.email} />
      )}
    </>
  );
}
