// The file watch's thread (see FileWatchThread), started by file-watcher.ts.
import { FileWatchThread } from "./file-watch-thread";

declare const self: Worker;

FileWatchThread.serve(self);
