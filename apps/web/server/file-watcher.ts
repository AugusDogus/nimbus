import { getDataRoot } from "@nimbus/api/data-root";
import { publishFileEvent } from "@nimbus/api/file-events";
import {
  ensureSearchIndex,
  notifySearchChange,
  requestSearchRescan,
} from "./search-bridge";
import { startFileWatch, type FileWatchHandle } from "./watch.worker";

let watching: FileWatchHandle | null = null;

export const ensureFileWatcher = () => {
  if (watching) return;
  ensureSearchIndex();
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
  watching = startFileWatch(
    root,
    debounceMs,
    (event) => {
      publishFileEvent(event);
      notifySearchChange(event.path);
    },
    () => {
      console.warn(
        "Nimbus's file watcher fell behind and dropped events. Search results and storage usage are being rebuilt from disk; files are unaffected.",
      );
      requestSearchRescan();
    },
  );
};
