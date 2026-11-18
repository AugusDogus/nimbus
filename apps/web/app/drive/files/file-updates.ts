/** Queries a file change can make out of date: the listings, storage use and search. */
const changed = ["files.list", "files.storage", "catalog"];

/**
 * A resync means the server dropped changes for this tab because it fell behind, so anything
 * derived from files may be out of date: trash, links, upload links (moved or trashed with their
 * folders), permissions, an open preview, versions.
 */
const resynced = [
  ...changed,
  "trash",
  "shares",
  "file-requests",
  "permissions",
  "preview",
  "versions",
];

/** Live updates collected between refreshes. */
export const FileUpdates = {
  /**
   * Gathers what a burst of updates makes out of date; `flush` refreshes each query once,
   * through `refresh`, however many updates named it. `resync` says a resync was among them.
   */
  collector(refresh: (keys: string[], resync: boolean) => void) {
    let wanted = new Set<string>();
    let resync = false;
    return {
      add(update: { kind: "delta" | "resync" }) {
        if (update.kind === "resync") resync = true;
        for (const key of update.kind === "resync" ? resynced : changed)
          wanted.add(key);
      },
      flush() {
        if (wanted.size === 0) return;
        const keys = [...wanted];
        const all = resync;
        wanted = new Set();
        resync = false;
        refresh(keys, all);
      },
    };
  },
} as const;
