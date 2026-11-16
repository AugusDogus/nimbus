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

/**
 * Watch `root` recursively, emitting one debounced event per changed path.
 * When the kernel's event queue overflows, Bun reports a change without a
 * filename: events were dropped, and folders created meanwhile are not
 * watched. The watch is then recreated, which watches every current folder
 * again, and `onLost` is called so state built from events can be rebuilt.
 */
export const startFileWatch = (
  root: string,
  debounceMs: number,
  emit: (event: FileEvent) => void,
  onLost: () => void = () => {},
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

  const listener = (event: string, relativePath: string | null) => {
    if (!relativePath) {
      watcher.close();
      watcher = watch(root, { recursive: true }, listener);
      onLost();
      return;
    }

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
  };
  let watcher = watch(root, { recursive: true }, listener);

  return {
    close: () => {
      watcher.close();
      if (timer) clearTimeout(timer);
      pending.clear();
      timer = null;
    },
  };
};
