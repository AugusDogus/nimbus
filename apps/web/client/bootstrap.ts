import type { QueryClient } from "@tanstack/react-query";
import type { UserPreferences } from "@nimbus/api/context";
import { sessionQuery, type SignedIn } from "@/lib/session-query";
import { prefsQueryOptions } from "@/app/drive/files/use-file-preferences";
import { inlineJson, readInlineJson } from "@/lib/inline-json";
import { trpc } from "@/lib/trpc";

/**
 * Data the server already knows when it sends a page: the session and browsing preferences of a
 * signed-in page, or the sign-in options of a sign-in page. The page carries it as JSON, so the
 * app starts without asking for it again.
 */
export type Bootstrap = {
  session?: SignedIn;
  prefs?: UserPreferences;
  signInOptions?: SignInOptions;
};

type SignInOptions = {
  setupAvailable: boolean;
  singleSignOn: string | null;
  passwordReset: boolean;
};

export const bootstrapElementId = "nimbus-bootstrap";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const oneOf = <T extends string>(value: unknown, options: readonly T[]) =>
  options.find((option) => option === value);

function parseSession(value: unknown): SignedIn | undefined {
  if (!isRecord(value) || !isRecord(value.user)) return undefined;
  const { id, name, email } = value.user;
  return typeof id === "string" &&
    typeof name === "string" &&
    typeof email === "string"
    ? { user: { id, name, email } }
    : undefined;
}

function parsePrefs(value: unknown): UserPreferences | undefined {
  if (!isRecord(value) || typeof value.groupByType !== "boolean")
    return undefined;
  const view = oneOf(value.view, ["list", "grid"] as const);
  const sortField = oneOf(value.sortField, [
    "name",
    "type",
    "modified",
    "size",
  ] as const);
  const sortDirection = oneOf(value.sortDirection, ["asc", "desc"] as const);
  return view && sortField && sortDirection
    ? { view, sortField, sortDirection, groupByType: value.groupByType }
    : undefined;
}

function parseSignInOptions(value: unknown): SignInOptions | undefined {
  if (
    !isRecord(value) ||
    typeof value.setupAvailable !== "boolean" ||
    typeof value.passwordReset !== "boolean" ||
    (value.singleSignOn !== null && typeof value.singleSignOn !== "string")
  )
    return undefined;
  return {
    setupAvailable: value.setupAvailable,
    singleSignOn: value.singleSignOn,
    passwordReset: value.passwordReset,
  };
}

export const Bootstrap = {
  serialize: (value: Bootstrap) => inlineJson(value),

  /** Seeds the query cache with the page's data, ignoring anything malformed. */
  seed(queryClient: QueryClient) {
    const value = readInlineJson(bootstrapElementId);
    if (!isRecord(value)) return;
    const session = parseSession(value.session);
    if (session) queryClient.setQueryData(sessionQuery.queryKey, session);
    const prefs = parsePrefs(value.prefs);
    if (prefs) queryClient.setQueryData(prefsQueryOptions.queryKey, prefs);
    const options = parseSignInOptions(value.signInOptions);
    if (options)
      queryClient.setQueryData(trpc.signIn.options.queryKey(), options);
  },
} as const;
