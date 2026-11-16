import { queryOptions } from "@tanstack/react-query";

/** The signed-in account, as pages need it before the auth client has loaded. */
export type SignedIn = {
  user: { id: string; name: string; email: string };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

function parseSession(value: unknown): SignedIn | null {
  if (!isRecord(value) || !isRecord(value.user)) return null;
  const { id, name, email } = value.user;
  return typeof id === "string" &&
    typeof name === "string" &&
    typeof email === "string"
    ? { user: { id, name, email } }
    : null;
}

/**
 * The signed-in session, or null when signed out. Read once per page load to gate signed-in
 * pages; the server still checks the session on every request. It reads Better Auth's session
 * endpoint directly, so public pages never load the auth client.
 */
export const sessionQuery = queryOptions({
  queryKey: ["session"],
  queryFn: async (): Promise<SignedIn | null> => {
    // The page preloads this exact request, so it must stay a plain GET.
    const response = await fetch("/api/auth/get-session");
    if (!response.ok)
      throw new Error(
        `Nimbus could not check your sign-in (HTTP ${response.status}). Reload the page to try again.`,
      );
    return parseSession(await response.json());
  },
  staleTime: Number.POSITIVE_INFINITY,
});
