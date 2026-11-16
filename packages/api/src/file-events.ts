import { EventEmitter, on } from "node:events";

export type FileEvent = {
  path: string;
  event: "rename" | "change" | "delete" | "unknown";
  ts: number;
};

export type FileDelta = {
  path: string;
  name: string;
  type: "dir" | "file" | "other";
  action: "added" | "removed" | "changed";
  ts: number;
};

type FileEventListener = (event: FileEvent) => void;

const globalForEvents = globalThis as typeof globalThis & {
  __nimbusFileEvents?: EventEmitter;
};

const fileEvents = globalForEvents.__nimbusFileEvents ?? new EventEmitter();
if (!globalForEvents.__nimbusFileEvents) {
  globalForEvents.__nimbusFileEvents = fileEvents;
  fileEvents.setMaxListeners(0);
}

export const publishFileEvent = (event: FileEvent) => {
  fileEvents.emit("file-change", event);
};

export const subscribeFileEvents = (listener: FileEventListener) => {
  fileEvents.on("file-change", listener);
  return () => {
    fileEvents.off("file-change", listener);
  };
};

export const iterateFileEvents = (signal: AbortSignal) => {
  return on(fileEvents, "file-change", { signal });
};
