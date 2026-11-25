import { TRPCError } from "@trpc/server";
import type { Access } from "./access";
import { entryAt, type FileEntry } from "./file-browser";
import { isApiError } from "./safe-path";
import { SearchCursor } from "./search-cursor";
import { SearchHighlight } from "./search-highlight";
import type {
  HistoryEntry,
  SearchDepth,
  SearchMatch,
  SearchRequest,
  SearchResult,
} from "./search-index";

export type SearchAnswer = SearchResult & {
  /** False while the first crawl after startup is still running. */
  complete: boolean;
};

/**
 * The drive index: one model of the tree, built by one crawl and kept current
 * by the file watcher, that answers filename searches and storage usage. The
 * web server runs it in a worker.
 */
export type SearchService = {
  /**
   * `caller` (a user id) is who asks, for bounding each caller's searches;
   * `signal` aborts a search nobody waits for any more, so it stops using
   * the index.
   */
  search: (
    request: SearchRequest,
    options: { caller: string; signal?: AbortSignal },
  ) => Promise<SearchAnswer>;
  /** Bytes in every indexed file, once the first crawl after startup has finished. */
  usage: () => Promise<number>;
};

/** Provided by the web server's worker bridge, or by tests. */
let provided: SearchService | null = null;

export const provideSearchService = (service: SearchService) => {
  provided = service;
};

const runningService = (): SearchService => {
  const service = provided;
  if (!service)
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message:
        "The drive index is not running in this server process. Restart Nimbus with `bun run start`; your files are unaffected.",
    });
  return service;
};

/** Total size of the files Nimbus serves, excluding `.nimbus`, symlinks and special files. */
export const driveUsage = () => runningService().usage();

export type SearchOptions = {
  depth?: SearchDepth;
  cursor?: string;
  history?: readonly HistoryEntry[];
  signal?: AbortSignal;
  /**
   * `destinations` finds only folders the caller can write to, such as for a move. The index
   * filters both before it limits the results, so a page is never short of them.
   */
  find?: "entries" | "destinations";
};

/** A search result as callers see it: the entry, which layer found it, and where it matched. */
export type SearchEntry = FileEntry & {
  match: SearchMatch;
  highlight: SearchHighlight;
};

/**
 * Why a hit could not be stated from disk: gone, a path Nimbus refuses (a
 * symlink above it, a name it cannot serve), or a filesystem error.
 */
const unstatable = (error: unknown) =>
  isApiError(error, "NOT_FOUND") ||
  isApiError(error, "BAD_REQUEST") ||
  isApiError(error, "FORBIDDEN") ||
  (error instanceof Error && "syscall" in error);

/**
 * Filename search for one caller. The index already limits results to the
 * caller's grants; every hit is re-checked here and stated from disk, so a
 * stale index can never reveal a path the caller cannot read.
 */
export async function searchEntries(
  access: Access,
  root: string,
  query: string,
  limit: number,
  options: SearchOptions = {},
) {
  const service = runningService();
  const destinations = options.find === "destinations";
  // Write access comes from write and admin grants alone: searching only beneath them leaves
  // out everything else before the index ranks anything.
  const scopeGrants = destinations
    ? access.grants.filter((grant) => grant.permission !== "read")
    : access.grants;
  const answer = await service.search(
    {
      query,
      root,
      limit,
      scope: access.isAdmin
        ? { type: "all" }
        : { type: "grants", paths: scopeGrants.map((grant) => grant.path) },
      only: destinations ? "folders" : undefined,
      depth: options.depth,
      // A cursor that cannot be opened is passed on as text no page
      // returned, so the search restarts and says so.
      cursor:
        options.cursor === undefined
          ? undefined
          : (SearchCursor.open(options.cursor, access.user.id) ?? ""),
      history: options.history,
    },
    { caller: access.user.id, signal: options.signal },
  );
  const entries = await Promise.all(
    answer.hits.map(async (hit): Promise<SearchEntry | null> => {
      if (!access.can(hit.path, destinations ? "write" : "read")) return null;
      try {
        return {
          ...(await entryAt(hit.path)),
          match: hit.match,
          highlight: SearchHighlight.forPath(
            hit.path,
            answer.terms,
            answer.split,
          ),
        };
      } catch (error) {
        // Removed or changed since it was indexed (the watcher will catch up),
        // or a path Nimbus cannot serve: one hit, not the whole search.
        if (unstatable(error)) return null;
        throw error;
      }
    }),
  );
  return {
    entries: entries.filter((entry) => entry !== null),
    truncated: answer.truncated,
    total: answer.total,
    next:
      answer.next === null
        ? null
        : SearchCursor.seal(answer.next, access.user.id),
    restarted: answer.restarted,
    complete: answer.complete,
  };
}
