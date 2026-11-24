import { EventLoopStalls } from "./event-loop-stalls";
import { watch } from "node:fs";
import { access, constants } from "node:fs/promises";
import path from "node:path";

export type WatchEvent = "rename" | "change" | "delete" | "unknown";

export type FileEvent = {
  path: string;
  event: WatchEvent;
  ts: number;
};

export type FileWatchHandle = {
  /** Whether changes are watched now: not while it waits to restart, nor after the watch limit. */
  watching: () => boolean;
  /**
   * Folders found unreadable some other way, such as by a crawl. Bun reports only the first
   * folder its initial walk cannot add, though it skips every such folder, so these are
   * logged and checked again like the folders it reports.
   */
  unreadable: (
    folders: readonly { path: string; code: string | null }[],
  ) => void;
  close: () => void;
};

/** What the watch needs from a recursive `fs.watch`; tests pass one that fails on purpose. */
export type Watcher = {
  on(event: "error", listener: (error: Error) => void): unknown;
  close(): void;
};
export type WatchTree = (
  root: string,
  listener: (event: string, filename: string | null) => void,
) => Watcher;

export type FileWatchOptions = {
  watch?: WatchTree;
  /** Where problems are reported, one line each. */
  log?: (message: string) => void;
  /** How often folders that could not be read are checked again. */
  recheckMs?: number;
  /** The first wait before restarting after a failure; it doubles up to `maxRetryMs`. */
  retryMs?: number;
  /** Told whenever changes start or stop being watched (see `FileWatchHandle.watching`). */
  onWatching?: (watching: boolean) => void;
};

const watchRecursively: WatchTree = (root, listener) =>
  watch(root, { recursive: true }, listener);

/** The longest wait between restarts, and how long a watch must run to count as healthy. */
const maxRetryMs = 5 * 60_000;
/** Unreadable folders logged one by one; past this, one line says more were found. */
const maxLoggedFolders = 50;

const codeOf = (error: unknown) =>
  error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : null;
const pathOf = (error: unknown) =>
  error instanceof Error && "path" in error && typeof error.path === "string"
    ? error.path
    : null;

const seconds = (ms: number) =>
  ms >= 120_000 ? `${Math.round(ms / 60_000)} minutes` : `${ms / 1000} seconds`;

/**
 * What a watch error means. An error for one folder below the root leaves the rest watched,
 * as Bun goes on adding the others; Bun reports a folder it may not read as EPERM (errno
 * EACCES), and one whose path is too long as ENAMETOOLONG. ENOSPC is the inotify watch limit.
 * Running out of descriptors, or any error for the root itself or without a path, needs the
 * watch started again: restarting for one folder's error would only meet it again.
 */
type Failure =
  /** Removed, or replaced by a symlink, while it was added: its parent reports that. */
  | { kind: "gone" }
  | { kind: "folder"; folder: string; code: string | null }
  | { kind: "limit" }
  | { kind: "restart"; reason: string; message: string };

function classify(root: string, error: unknown): Failure {
  const code = codeOf(error);
  const at = pathOf(error);
  const relative = at === null ? "" : path.relative(root, at);
  const below =
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative);
  const refused = code === "EACCES" || code === "EPERM";
  const retrying =
    "Nimbus keeps serving and tries again with growing waits of up to 5 minutes; changes made meanwhile are found when it does.";
  if (code === "ENOSPC") return { kind: "limit" };
  if (code === "EMFILE" || code === "ENFILE")
    return {
      kind: "restart",
      reason: code,
      message: `Nimbus's file watcher could not open another file (${code}): the ${code === "EMFILE" ? "process's" : "system's"} limit on open files or inotify instances (fs.inotify.max_user_instances) is reached. Files are unaffected. ${retrying} If this repeats, raise that limit.`,
    };
  if (below && (code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP"))
    return { kind: "gone" };
  if (below && at !== null) return { kind: "folder", folder: at, code };
  if (code === "ENOENT" || code === "ENOTDIR")
    return {
      kind: "restart",
      reason: `root ${code}`,
      message: `Nimbus cannot watch the data root ${root}: it is gone (${code}), perhaps removed, renamed or unmounted. ${retrying} Restore or remount it.`,
    };
  if (refused)
    return {
      kind: "restart",
      reason: "root refused",
      message: `Nimbus cannot watch the data root ${root}: permission denied. ${retrying} Give the user Nimbus runs as (uid ${process.getuid?.() ?? "unknown"}) read and execute permission on it.`,
    };
  const detail =
    code ?? (error instanceof Error ? error.message : String(error));
  return {
    kind: "restart",
    reason: `unknown ${detail}`,
    message: `Nimbus's file watcher failed (${detail}${at === null ? "" : ` at ${at}`}). Files are unaffected. ${retrying} If this repeats, report this line.`,
  };
}

const folderProblem = (folder: string, code: string | null) =>
  code === "EACCES" || code === "EPERM"
    ? `read the folder ${folder} (permission denied), so it does not follow changes inside it and search does not include its contents`
    : code === "ENAMETOOLONG"
      ? `watch the folder ${folder}: its path is longer than the system allows (ENAMETOOLONG), so it does not follow changes inside it`
      : `watch the folder ${folder} (${code ?? "unknown error"}), so it does not follow changes inside it`;

const folderRemedy = (code: string | null) =>
  code === "EACCES" || code === "EPERM"
    ? `To include it, give the user Nimbus runs as (uid ${process.getuid?.() ?? "unknown"}) read and execute permission on it.`
    : code === "ENAMETOOLONG"
      ? "To include it, move it to a shorter path."
      : "Check the folder and the disk it is on.";

/**
 * Watch `root` recursively, emitting one debounced event per changed path.
 * When the kernel's event queue overflows, Bun reports a change without a
 * filename: events were dropped, and folders created meanwhile are not
 * watched. The watch is then recreated, which watches every current folder
 * again, and `onLost` is called so state built from events can be rebuilt.
 *
 * Every watch error is handled here, never left to crash the process:
 * - A folder below the root that it may not read, or cannot watch for another reason such as
 *   a path too long, is not watched, and is logged once. It is checked again every
 *   `recheckMs`; once readable, the watch is recreated so it is included, and `onLost` called.
 * - At the inotify watch limit (ENOSPC) it stops watching for good and releases its watches,
 *   which other programs of the same user share; the caller's periodic reconciliation is then
 *   how changes made outside Nimbus are found.
 * - Anything else, including the root going away, closes the watch and starts it again after
 *   a wait that doubles on each failure, then calls `onLost`.
 */
export const startFileWatch = (
  root: string,
  debounceMs: number,
  emit: (event: FileEvent) => void,
  onLost: () => void = () => {},
  options: FileWatchOptions = {},
): FileWatchHandle => {
  const watchTree = options.watch ?? watchRecursively;
  const log = options.log ?? console.warn;
  const recheckMs = options.recheckMs ?? 30 * 60_000;
  const retryMs = options.retryMs ?? 1000;
  const pending = new Map<string, FileEvent>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let watcher: Watcher | null = null;
  let closed = false;
  /** Restarts since the watch last ran healthily, which sets the next wait. */
  let failures = 0;
  let startedAt = 0;
  /** The failure logged since the watch last ran healthily, so a repeat is not logged again. */
  let reported: string | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  /** Folders it may not read, so not watched; checked again every `recheckMs`. */
  const unwatched = new Set<string>();
  /** Folders already logged, so one that recovers and fails again is not logged twice. */
  const loggedFolders = new Set<string>();
  let moreLogged = false;
  let recheck: ReturnType<typeof setTimeout> | null = null;

  const flush = () =>
    EventLoopStalls.track("delivery of watched file changes", () => {
      for (const event of pending.values()) {
        emit(event);
      }
      pending.clear();
      timer = null;
    });

  const listener = (event: string, relativePath: string | null) => {
    if (!relativePath) {
      restartNow();
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

  const stop = () => {
    if (!watcher) return;
    watcher.close();
    watcher = null;
    options.onWatching?.(false);
  };

  /** Start watching; a failure to start is handled like any other watch error. */
  const start = () => {
    try {
      // Bun adds a watch for every folder of the drive before this returns.
      const started: Watcher = EventLoopStalls.track("file watch setup", () =>
        watchTree(root, (event, filename) => {
          if (watcher === started) listener(event, filename);
        }),
      );
      started.on("error", (error) => {
        if (watcher === started) fail(error);
      });
      watcher = started;
      startedAt = Date.now();
      options.onWatching?.(true);
      return true;
    } catch (error) {
      fail(error);
      return false;
    }
  };

  /** Watch every current folder again, then catch up with what was missed meanwhile. */
  const restartNow = () => {
    stop();
    if (start()) onLost();
  };

  function fail(error: unknown) {
    if (closed) return;
    const failure = classify(root, error);
    switch (failure.kind) {
      case "gone":
        return;
      case "folder":
        skipFolder(failure.folder, failure.code);
        return;
      case "limit":
        if (watcher === null && reported === "limit") return;
        stop();
        if (retry) clearTimeout(retry);
        retry = null;
        reported = "limit";
        log(
          `Nimbus stopped watching the drive for changes: the system's inotify watch limit (fs.inotify.max_user_watches) is reached, and Nimbus needs one watch per folder. Its watches were released, so other programs keep theirs. Files are unaffected and Nimbus keeps serving; changes made outside Nimbus now reach search and storage usage only at the next periodic reconciliation, and open folders no longer update by themselves. Raise fs.inotify.max_user_watches on the host (for example sysctl fs.inotify.max_user_watches=1048576) and restart Nimbus.`,
        );
        return;
      case "restart": {
        const running = watcher !== null;
        stop();
        // A watch that ran for a while before failing starts the waits over.
        if (running && Date.now() - startedAt > maxRetryMs) {
          failures = 0;
          reported = null;
        }
        if (reported !== failure.reason) {
          reported = failure.reason;
          log(failure.message);
        }
        if (retry) return;
        const wait = Math.min(retryMs * 2 ** failures, maxRetryMs);
        failures++;
        retry = setTimeout(() => {
          retry = null;
          if (start()) onLost();
        }, wait);
        retry.unref();
        return;
      }
    }
  }

  /** Leave out a folder that cannot be watched: logged once, and checked again later. */
  function skipFolder(folder: string, code: string | null) {
    if (closed || unwatched.has(folder)) return;
    unwatched.add(folder);
    scheduleRecheck();
    if (loggedFolders.has(folder)) return;
    if (loggedFolders.size < maxLoggedFolders) {
      loggedFolders.add(folder);
      log(
        `Nimbus cannot ${folderProblem(folder, code)}. Everything else in the drive is watched as usual. ${folderRemedy(code)} Nimbus checks again every ${seconds(recheckMs)}.`,
      );
    } else if (!moreLogged) {
      moreLogged = true;
      log(
        `Nimbus found more than ${maxLoggedFolders} folders it cannot read; further ones are not logged one by one. Each is skipped as described above.`,
      );
    }
  }

  function scheduleRecheck() {
    if (recheck || closed) return;
    recheck = setTimeout(() => {
      recheckFolders()
        .catch((error: unknown) =>
          log(
            `Nimbus could not check whether unreadable folders became readable (${error instanceof Error ? error.message : String(error)}). Everything else stays watched; it checks again in ${seconds(recheckMs)}.`,
          ),
        )
        .finally(() => {
          recheck = null;
          if (unwatched.size) scheduleRecheck();
        });
    }, recheckMs);
    recheck.unref();
  }

  /** Watch again once a folder that could not be read can be; forget ones that are gone. */
  async function recheckFolders() {
    let readable = false;
    for (const folder of [...unwatched]) {
      try {
        await access(folder, constants.R_OK | constants.X_OK);
        unwatched.delete(folder);
        readable = true;
      } catch (error) {
        const code = codeOf(error);
        if (code === "ENOENT" || code === "ENOTDIR") unwatched.delete(folder);
      }
    }
    // Waiting to restart or stopped at the limit: a restart, if any, includes it anyway.
    if (readable && watcher && !closed) restartNow();
  }

  start();

  return {
    watching: () => watcher !== null,
    unreadable: (folders) => {
      for (const folder of folders) skipFolder(folder.path, folder.code);
    },
    close: () => {
      closed = true;
      stop();
      if (retry) clearTimeout(retry);
      if (recheck) clearTimeout(recheck);
      if (timer) clearTimeout(timer);
      pending.clear();
      timer = null;
    },
  };
};
