import { EventEmitter } from "node:events";

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

/**
 * What a live-update subscriber receives: a change, or a notice that changes were dropped
 * because it fell too far behind, so it must reload what it shows.
 */
export type FileUpdate =
  | ({ kind: "delta" } & FileDelta)
  | { kind: "resync"; ts: number };

/** An event for one subscriber, or the notice that its queue overflowed. */
export type QueuedFileEvent =
  | { kind: "event"; event: FileEvent }
  | { kind: "overflow" };

/**
 * Events one subscriber may fall behind by. Beyond this, as when 50,000 files arrive at once
 * and a client reads slowly, its queue is dropped for one overflow notice instead of growing.
 */
export const maxQueuedFileEvents = 10_000;

/** Every event published from the first request for an item until `signal` aborts. */
export async function* iterateFileEvents(
  signal: AbortSignal,
  maxQueued = maxQueuedFileEvents,
): AsyncGenerator<QueuedFileEvent> {
  let queue: FileEvent[] = [];
  let head = 0;
  let overflowed = false;
  let wake: (() => void) | null = null;
  const unsubscribe = subscribeFileEvents((event) => {
    // Events after an overflow are covered by the reload it asks for.
    if (!overflowed) {
      if (queue.length - head >= maxQueued) {
        queue = [];
        head = 0;
        overflowed = true;
      } else queue.push(event);
    }
    wake?.();
  });
  // Wakes a waiting reader directly. Racing each wait against one long-lived abort promise
  // would leave a reaction on it per wait, growing for as long as the stream stays open.
  const onAbort = () => wake?.();
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    while (!signal.aborted) {
      if (overflowed) {
        overflowed = false;
        yield { kind: "overflow" };
        continue;
      }
      const event = queue[head];
      if (event !== undefined) {
        head++;
        // Read events are released: all at once when the queue empties, otherwise now and
        // then, so reading from the front stays cheap.
        if (head === queue.length) {
          queue = [];
          head = 0;
        } else if (head > 1024 && head * 2 > queue.length) {
          queue = queue.slice(head);
          head = 0;
        }
        yield { kind: "event", event };
        continue;
      }
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
      wake = null;
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    unsubscribe();
  }
}
