import { getDataRoot } from "@nimbus/api/data-root";
import { publishFileEvent, subscribeFileEvents } from "@nimbus/api/file-events";
import {
  ensureSearchIndex,
  notifySearchChange,
  requestSearchRescan,
  stopSearchIndex,
} from "./search-bridge";
import { FileWatchThread } from "./file-watch-thread";
import { reconcileIntervalMs } from "./search-protocol";
import type { FileWatchHandle } from "./watch.worker";

let watching: FileWatchHandle | null = null;

/** Stop watching the drive for good, as a draining server does. Search stops with it. */
export const stopFileWatcher = () => {
  watching?.close();
  watching = null;
  stopSearchIndex();
};

export const ensureFileWatcher = () => {
  if (watching) return;
  // Bun names only the first folder its watch cannot add; the index finds every one.
  ensureSearchIndex((folders) => watching?.unreadable(folders));
  const root = getDataRoot();
  const configuredDebounce = Number(
    process.env.NIMBUS_WATCH_DEBOUNCE_MS ?? "300",
  );
  const debounceMs =
    Number.isFinite(configuredDebounce) && configuredDebounce >= 0
      ? configuredDebounce
      : 300;
  // On a thread of its own: setting the watch up walks every folder (see FileWatchThread).
  const handle = FileWatchThread.start({
    spawn: () =>
      new Worker(new URL("./file-watch.thread.ts", import.meta.url), {
        type: "module",
      }),
    root,
    debounceMs,
    emit: (event) => {
      publishFileEvent(event);
      notifySearchChange(event.path);
    },
    onLost: () => {
      console.warn(
        "Nimbus's file watcher missed changes. Search results and storage usage are being rebuilt from disk; files are unaffected.",
      );
      requestSearchRescan();
    },
    // Unreadable folders are checked again as often as the index is reconciled.
    recheckMs: reconcileIntervalMs(),
  });
  watching = handle;
  // Changes Nimbus makes itself are published as they happen. While the watcher is not
  // running, such as at the system's watch limit, they reach search this way instead of
  // waiting for the next reconciliation.
  subscribeFileEvents((event) => {
    if (!handle.watching()) notifySearchChange(event.path);
  });
};
