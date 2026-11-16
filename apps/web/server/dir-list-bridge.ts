import "server-only";

import path from "node:path";

import { getDataRoot } from "@nimbus/api/data-root";
import { setDirEntries } from "@nimbus/api/dir-list-cache";

type ListDirRequest = { type: "list-dir"; path: string };
type WorkerRequest = ListDirRequest;

type DirEntry = {
  name: string;
  path: string;
  type: "dir" | "file" | "other";
};

type DirListResponse = {
  type: "dir-list";
  relativeDir: string;
  entries: DirEntry[];
  dirMtimeMs: number | null;
};

type WorkerResponse = DirListResponse;

type DirListBridgeState = {
  worker: Worker | null;
};

const globalForDirListBridge = globalThis as typeof globalThis & {
  __nimbusDirListBridge?: DirListBridgeState;
};

const startWorker = () => {
  if (globalForDirListBridge.__nimbusDirListBridge) {
    return;
  }

  if (typeof Worker === "undefined") {
    console.warn(
      "[nimbus] Dir list worker requires Bun Worker. Start the server with Bun runtime to enable directory cache updates.",
    );
    globalForDirListBridge.__nimbusDirListBridge = { worker: null };
    return;
  }

  const worker = new Worker(new URL("./dir-list.worker.ts", import.meta.url), {
    type: "module",
  });

  worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
    const message = event.data;
    if (!message || typeof message !== "object") {
      return;
    }
    if (message.type === "dir-list") {
      setDirEntries(message.relativeDir, message.entries, message.dirMtimeMs);
    }
  };

  globalForDirListBridge.__nimbusDirListBridge = { worker };
};

export const ensureDirListBridge = () => {
  startWorker();
};

export const requestDirRecache = (absolutePath: string) => {
  const bridge = globalForDirListBridge.__nimbusDirListBridge;
  if (!bridge || !bridge.worker) {
    return;
  }
  if (absolutePath === "") {
    const root = getDataRoot();
    const message: WorkerRequest = { type: "list-dir", path: root };
    bridge.worker.postMessage(message);
    return;
  }
  const root = getDataRoot();
  const absolute = path.isAbsolute(absolutePath)
    ? absolutePath
    : path.resolve(root, absolutePath);
  const message: WorkerRequest = { type: "list-dir", path: absolute };
  bridge.worker.postMessage(message);
};
