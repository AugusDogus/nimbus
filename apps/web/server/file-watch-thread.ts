import { EventLoopStalls } from "./event-loop-stalls";
import {
  startFileWatch,
  type FileEvent,
  type FileWatchHandle,
  type WatchTree,
} from "./watch.worker";

/**
 * The drive's file watch, on a thread of its own. Bun's recursive `fs.watch` adds a watch for
 * every folder before it returns, synchronously: 42 ms for 5,000 folders on a local disk, and
 * seconds for a large drive whose folders are slow to list, such as a FUSE mount over a disk
 * array. That runs at startup and again whenever the watch restarts (a lost event queue, a
 * folder readable again, a failure), and on the server's own thread it would stop every
 * request and stream meanwhile. Here only this thread waits; events reach the server in
 * batches.
 */
export type FileWatchInbound =
  | { type: "start"; root: string; debounceMs: number; recheckMs: number }
  | {
      type: "unreadable";
      folders: { path: string; code: string | null }[];
    }
  | { type: "close" };

export type FileWatchOutbound =
  | { type: "events"; events: FileEvent[] }
  /** Events were missed: what was built from them must be rebuilt. */
  | { type: "lost" }
  | { type: "log"; line: string }
  | { type: "watching"; value: boolean };

/** The thread's side of the channel: a worker's `self`, or a fake in tests. */
export type FileWatchScope = {
  postMessage(message: FileWatchOutbound): void;
  onmessage: ((event: MessageEvent<FileWatchInbound>) => void) | null;
};

/** What the server needs from the thread: a Bun Worker. */
export type FileWatchPort = {
  postMessage(message: FileWatchInbound): void;
  terminate(): void;
  onmessage: ((event: MessageEvent<FileWatchOutbound>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
};

export const FileWatchThread = {
  /** Run the watch inside the thread, as `scope` asks. `watch` replaces `fs.watch` in tests. */
  serve(scope: FileWatchScope, watch?: WatchTree) {
    let handle: FileWatchHandle | null = null;
    let batch: FileEvent[] = [];
    const queue = (event: FileEvent) => {
      if (!batch.length)
        queueMicrotask(() => {
          const events = batch;
          batch = [];
          scope.postMessage({ type: "events", events });
        });
      batch.push(event);
    };
    scope.onmessage = (event) => {
      const message = event.data;
      switch (message.type) {
        case "start":
          handle ??= startFileWatch(
            message.root,
            message.debounceMs,
            queue,
            () => scope.postMessage({ type: "lost" }),
            {
              recheckMs: message.recheckMs,
              watch,
              log: (line) => scope.postMessage({ type: "log", line }),
              onWatching: (value) =>
                scope.postMessage({ type: "watching", value }),
            },
          );
          return;
        case "unreadable":
          handle?.unreadable(message.folders);
          return;
        case "close":
          handle?.close();
          handle = null;
          return;
      }
    };
  },

  /**
   * Watch `root` on the thread `spawn` starts. Events, losses and problems arrive as
   * `startFileWatch` reports them, delivered on this thread.
   */
  start({
    spawn,
    root,
    debounceMs,
    recheckMs,
    emit,
    onLost,
    log = console.warn,
  }: {
    spawn: () => FileWatchPort;
    root: string;
    debounceMs: number;
    recheckMs: number;
    emit: (event: FileEvent) => void;
    onLost: () => void;
    log?: (line: string) => void;
  }): FileWatchHandle {
    const port = spawn();
    let watching = false;
    port.onmessage = (event) => {
      const message = event.data;
      switch (message.type) {
        case "events":
          EventLoopStalls.track("delivery of watched file changes", () => {
            for (const change of message.events) emit(change);
          });
          return;
        case "lost":
          onLost();
          return;
        case "log":
          log(message.line);
          return;
        case "watching":
          watching = message.value;
          return;
      }
    };
    port.onerror = (event) => {
      watching = false;
      port.terminate();
      log(
        `Nimbus's file watcher stopped unexpectedly (${event.message}). Files are unaffected and Nimbus keeps serving; changes made outside Nimbus now reach search and storage usage only at the next periodic reconciliation, and open folders no longer update by themselves. Restart Nimbus to watch again.`,
      );
      onLost();
    };
    port.postMessage({ type: "start", root, debounceMs, recheckMs });
    return {
      watching: () => watching,
      unreadable: (folders) =>
        port.postMessage({ type: "unreadable", folders: [...folders] }),
      close: () => {
        watching = false;
        port.postMessage({ type: "close" });
        port.terminate();
      },
    };
  },
} as const;
