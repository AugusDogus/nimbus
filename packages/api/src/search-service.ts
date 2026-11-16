import { TRPCError } from "@trpc/server";
import type { Access } from "./access";
import { entryAt, type FileEntry } from "./file-browser";
import { isApiError } from "./safe-path";
import type { SearchRequest, SearchResult } from "./search-index";

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
  search: (request: SearchRequest) => Promise<SearchAnswer>;
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
) {
  const service = runningService();
  const answer = await service.search({
    query,
    root,
    limit,
    scope: access.isAdmin
      ? { type: "all" }
      : { type: "grants", paths: access.grants.map((grant) => grant.path) },
  });
  const entries = await Promise.all(
    answer.hits.map(async (hit): Promise<FileEntry | null> => {
      if (!access.can(hit.path, "read")) return null;
      try {
        return await entryAt(hit.path);
      } catch (error) {
        // Removed since it was indexed; the watcher will drop it shortly.
        if (isApiError(error, "NOT_FOUND")) return null;
        throw error;
      }
    }),
  );
  return {
    entries: entries.filter((entry) => entry !== null),
    truncated: answer.truncated,
    complete: answer.complete,
  };
}
