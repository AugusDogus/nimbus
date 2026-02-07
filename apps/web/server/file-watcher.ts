import "server-only";

import { getParentDir } from "@nimbus/api/dir-list-cache";
import { publishFileEvent, type FileEvent } from "@nimbus/api/file-events";
import { ensureDirListBridge, requestDirRecache } from "./dir-list-bridge";
import { ensureStatsBridge, requestStat } from "./stats-bridge";

type WorkerMessage = FileEvent;

type GlobalWatcher = typeof globalThis & {
  __nimbusFileWatcher?: Worker;
};

const globalForWatcher = globalThis as GlobalWatcher;

const isFileEvent = (value: unknown): value is FileEvent => {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.path === "string" &&
    typeof candidate.event === "string" &&
    typeof candidate.ts === "number"
  );
};

const startWatcher = () => {
  if (globalForWatcher.__nimbusFileWatcher) {
    return;
  }

  ensureStatsBridge();
  ensureDirListBridge();
  if (typeof Worker === "undefined") {
    console.warn(
      "[nimbus] File watcher requires Bun Worker. Start the server with Bun runtime to enable file events.",
    );
    return;
  }

  const worker = new Worker(new URL("./watch.worker-entry.ts", import.meta.url), {
    type: "module",
  });

  worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
    const payload = event.data;
    if (!isFileEvent(payload)) {
      return;
    }
    publishFileEvent(payload);
    requestStat(payload.path);
    const parentDir = getParentDir(payload.path);
    if (parentDir !== null) {
      requestDirRecache(parentDir);
    }
  };

  globalForWatcher.__nimbusFileWatcher = worker;
};

export const ensureFileWatcher = () => {
  startWatcher();
};
