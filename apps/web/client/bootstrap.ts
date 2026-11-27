import type { QueryClient } from "@tanstack/react-query";
import type { inferRouterOutputs } from "@trpc/server";
import type { UserPreferences } from "@nimbus/api/context";
import type { WebRouter } from "@/server/web-router";
import { trpc } from "@/lib/trpc";
import { sessionQuery, type SignedIn } from "@/lib/session-query";
import { prefsQueryOptions } from "@/app/drive/files/use-file-preferences";
import { inlineJson, readInlineJson } from "@/lib/inline-json";
import type { IconChoice } from "@/lib/icon-choice";

type Me = inferRouterOutputs<WebRouter>["access"]["me"];

/**
 * Data the server already knows when it sends a signed-in page: the session, browsing
 * preferences and, on file pages, the account with its top folder. The page carries it as JSON,
 * so the app starts without asking for it again, and roots the breadcrumb right the first time.
 */
export type Bootstrap = {
  session?: SignedIn;
  prefs?: UserPreferences;
  me?: Me;
  /** The account's file icon set, on file pages. The icon code reads it when it loads. */
  icons?: IconChoice;
};

export const bootstrapElementId = "nimbus-bootstrap";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const oneOf = <T extends string>(value: unknown, options: readonly T[]) =>
  options.find((option) => option === value);

/** The inlined session, in the `SignedIn` shape the server wrote. */
function parseSession(value: unknown): SignedIn | undefined {
  if (!isRecord(value) || !isRecord(value.user)) return undefined;
  const { id, name, email } = value.user;
  const { impersonatedBy } = value;
  return typeof id === "string" &&
    typeof name === "string" &&
    typeof email === "string" &&
    (impersonatedBy === null || typeof impersonatedBy === "string")
    ? { user: { id, name, email }, impersonatedBy }
    : undefined;
}

/** The inlined `access.me` answer, in the shape the server wrote. */
function parseMe(value: unknown): Me | undefined {
  if (!isRecord(value)) return undefined;
  const { id, name, email, role, banned, isAdmin, home, top } = value;
  return typeof id === "string" &&
    typeof name === "string" &&
    typeof email === "string" &&
    typeof role === "string" &&
    typeof banned === "boolean" &&
    typeof isAdmin === "boolean" &&
    (home === null || typeof home === "string") &&
    typeof top === "string"
    ? { id, name, email, role, banned, isAdmin, home, top }
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
    const me = parseMe(value.me);
    if (me) queryClient.setQueryData(trpc.access.me.queryKey(), me);
  },
} as const;
