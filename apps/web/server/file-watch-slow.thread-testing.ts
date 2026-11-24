// Tests only: a file watch thread whose watch takes 600 ms to set up, as `fs.watch` does over
// a large drive with slow folders, and then reports one change.
import { FileWatchThread } from "./file-watch-thread";

declare const self: Worker;

FileWatchThread.serve(self, (root, listener) => {
  // Blocks this thread, as Bun's walk of every folder does.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 600);
  setTimeout(() => listener("rename", "added.txt"), 50);
  return { on: () => undefined, close: () => undefined };
});
