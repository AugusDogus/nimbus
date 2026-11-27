import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { ColorThemeSync } from "@/lib/color-theme-sync";
import { sessionQuery } from "@/lib/session-query";
import ImpersonationBanner from "./impersonation-banner";
import { Toaster } from "./toaster";

/**
 * UI the app loads after its first render, so no page's first load carries it: the toast
 * area, the banner shown while an administrator is signed in as someone else, and the check
 * that this browser's color themes match the account's.
 */
export function AfterStart() {
  // Only reads the session the signed-in pages already loaded; never fetches it.
  const { data: session } = useQuery({ ...sessionQuery, enabled: false });
  const userId = session?.user.id ?? null;
  // An administrator signed in as someone else keeps their own browser's themes.
  const impersonating = Boolean(session?.impersonatedBy);
  useEffect(() => {
    if (userId === null || impersonating) return;
    ColorThemeSync.reconcile(userId).catch((error: unknown) => {
      // Offline or signed out meanwhile: the browser's copy stays until the next load.
      console.warn(
        "Nimbus could not check this browser's color themes with the server. They stay as they are until the next load.",
        error,
      );
    });
  }, [userId, impersonating]);
  return (
    <>
      <Toaster />
      {session?.impersonatedBy && (
        <ImpersonationBanner email={session.user.email} />
      )}
    </>
  );
}
