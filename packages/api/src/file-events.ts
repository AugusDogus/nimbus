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

const fileEvents = new EventEmitter();
// Every live-update subscription listens; there is no meaningful limit.
fileEvents.setMaxListeners(0);

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
