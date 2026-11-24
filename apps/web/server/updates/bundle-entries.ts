/**
 * The files a release bundle's server starts from, relative to apps/web: the server and every
 * worker thread it starts. The bundle keeps the dependencies these reach (see
 * scripts/release-bundle.ts), so a worker missing here would start without its imports.
 */
export const BUNDLE_ENTRIES = [
  "server/start.ts",
  "server/search.worker.ts",
  "server/search-scan.worker.ts",
  "server/file-watch.thread.ts",
] as const;
