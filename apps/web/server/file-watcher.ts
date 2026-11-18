import { getDataRoot } from "@nimbus/api/data-root";
import { publishFileEvent, subscribeFileEvents } from "@nimbus/api/file-events";
import {
  ensureSearchIndex,
  notifySearchChange,
  requestSearchRescan,
} from "./search-bridge";
import { reconcileIntervalMs } from "./search-protocol";
import { startFileWatch, type FileWatchHandle } from "./watch.worker";

let watching: FileWatchHandle | null = null;

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
  // fs.watch already delivers asynchronous notifications. Import its helper into
  // the server bundle so Next does not copy a worker entry without its imports.
  const handle = startFileWatch(
    root,
    debounceMs,
    (event) => {
      publishFileEvent(event);
      notifySearchChange(event.path);
    },
    () => {
      console.warn(
        "Nimbus's file watcher missed changes. Search results and storage usage are being rebuilt from disk; files are unaffected.",
      );
      requestSearchRescan();
    },
    // Unreadable folders are checked again as often as the index is reconciled.
    { recheckMs: reconcileIntervalMs() },
  );
  watching = handle;
  // Changes Nimbus makes itself are published as they happen. While the watcher is not
  // running, such as at the system's watch limit, they reach search this way instead of
  // waiting for the next reconciliation.
  subscribeFileEvents((event) => {
    if (!handle.watching()) notifySearchChange(event.path);
  });
};
