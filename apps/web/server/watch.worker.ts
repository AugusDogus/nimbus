import { watch } from "node:fs";
import path from "node:path";

export type WatchEvent = "rename" | "change" | "delete" | "unknown";

export type FileEvent = {
  path: string;
  event: WatchEvent;
  ts: number;
};

export type FileWatchHandle = {
  close: () => void;
};

export const startFileWatch = (
  root: string,
  debounceMs: number,
  emit: (event: FileEvent) => void,
): FileWatchHandle => {
  const pending = new Map<string, FileEvent>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    for (const event of pending.values()) {
      emit(event);
    }
    pending.clear();
    timer = null;
  };

  const watcher = watch(root, { recursive: true }, (event, relativePath) => {
    if (!relativePath) return;

    const fullPath = path.resolve(root, relativePath);
    const relative = path.relative(root, fullPath);
    if (
      relative
        .split(path.sep)
        .some((segment) => segment.toLowerCase() === ".nimbus")
    )
      return;
    const normalizedEvent: WatchEvent =
      event === "rename" || event === "change" ? event : "unknown";

    const payload: FileEvent = {
      path: fullPath,
      event: normalizedEvent,
      ts: Date.now(),
    };

    pending.set(fullPath, payload);
    if (!timer) {
      timer = setTimeout(flush, debounceMs);
    }
  });

  return {
    close: () => {
      watcher.close();
      if (timer) clearTimeout(timer);
      pending.clear();
      timer = null;
    },
  };
};
