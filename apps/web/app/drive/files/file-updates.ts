/** Queries a file change can make out of date: the listings, storage use and search. */
const changed = ["files.list", "files.storage", "catalog"];

/**
 * A resync means the server dropped changes for this tab because it fell behind, so anything
 * derived from files may be out of date: trash, links, permissions, an open preview, versions.
 */
const resynced = [
  ...changed,
  "trash",
  "shares",
  "permissions",
  "preview",
  "versions",
];

/** Live updates collected between refreshes. */
export const FileUpdates = {
  /**
   * Gathers what a burst of updates makes out of date; `flush` refreshes each query once,
   * through `refresh`, however many updates named it.
   */
  collector(refresh: (keys: string[]) => void) {
    let wanted = new Set<string>();
    return {
      add(update: { kind: "delta" | "resync" }) {
        for (const key of update.kind === "resync" ? resynced : changed)
          wanted.add(key);
      },
      flush() {
        if (wanted.size === 0) return;
        const keys = [...wanted];
        wanted = new Set();
        refresh(keys);
      },
    };
  },
} as const;
