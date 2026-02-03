import { EventEmitter } from "node:events";

export type FileEvent = {
  path: string;
  event: "rename" | "change" | "delete" | "unknown";
  ts: number;
};

type FileEventListener = (event: FileEvent) => void;

const globalForEvents = globalThis as typeof globalThis & {
  __nimbusFileEvents?: EventEmitter;
};

const fileEvents = globalForEvents.__nimbusFileEvents ?? new EventEmitter();
if (!globalForEvents.__nimbusFileEvents) {
  globalForEvents.__nimbusFileEvents = fileEvents;
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
