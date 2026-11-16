import { getDataRoot } from "@nimbus/api/data-root";
import { publishFileEvent } from "@nimbus/api/file-events";
import { ensureSearchIndex, notifySearchChange } from "./search-bridge";
import { startFileWatch, type FileWatchHandle } from "./watch.worker";

declare global {
  var __nimbusFileWatcher: FileWatchHandle | undefined;
}

export const ensureFileWatcher = () => {
  if (globalThis.__nimbusFileWatcher) return;
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
  globalThis.__nimbusFileWatcher = startFileWatch(root, debounceMs, (event) => {
    publishFileEvent(event);
    notifySearchChange(event.path);
  });
};
