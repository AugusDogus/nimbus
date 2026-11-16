/**
 * The folder listing request, as the client sends it and the page preloads it. The page asks
 * the browser to fetch this exact URL while the app's code downloads, and the app's first
 * listing query then reuses the response. If the two ever differ, the preload goes unused and
 * the listing loads as before.
 *
 * `fetchFileList` sends `fileListInput` through tRPC's batch link, and the file browser's first
 * listing goes alone in its batch, so the preloaded URL is the one it requests.
 */
export const fileListInput = (path: string, includeStats: boolean) =>
  path ? { path, includeStats } : { includeStats };

/** The URL tRPC's batch link requests for the listing when it is the only query in a batch. */
export const fileListRequest = (path: string, includeStats: boolean) =>
  `/api/trpc/files.list?batch=1&input=${encodeURIComponent(
    JSON.stringify({ 0: fileListInput(path, includeStats) }),
  )}`;
