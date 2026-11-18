import { existsSync, readlinkSync, realpathSync, type Stats } from "node:fs";
import path from "node:path";

/**
 * Where an open descriptor really is. A path checked with lstat can have a folder on it
 * swapped for a symlink before it is opened; opening without following a symlink in the last
 * part, then asking where the descriptor ended up, catches a swap anywhere on the path. On
 * Linux `/proc/self/fd` names each descriptor by the path that reaches its file. Shared by
 * drive file reads (`DriveFile`) and the search crawler's folder listings.
 */

/** Whether this system names open descriptors under /proc/self/fd. */
const available = existsSync("/proc/self/fd");

/** Each data root's real path, read again whenever a descriptor seems to be elsewhere. */
const realRoots = new Map<string, string>();
function realRoot(root: string, fresh: boolean) {
  let real = realRoots.get(root);
  if (real === undefined || fresh) {
    real = realpathSync(root);
    realRoots.set(root, real);
  }
  return real;
}

/**
 * Whether descriptor `fd`, described by `stats`, opened `relative` inside `root`, compared
 * exactly: a symlink to a differently cased folder is another folder on case-sensitive
 * storage. Only where `available`. A procfs lookup never waits on storage, so it is
 * synchronous. A file renamed over or deleted since it was opened has no names left and is
 * reported with a suffix; a live file's own name may end the same way, so the suffix is
 * removed only from a file without names.
 */
function opened(
  fd: number,
  stats: Pick<Stats, "nlink">,
  root: string,
  relative: string,
) {
  const link = readlinkSync(`/proc/self/fd/${fd}`);
  const actual = stats.nlink === 0 ? link.replace(/ \(deleted\)$/, "") : link;
  return (
    actual === path.join(realRoot(root, false), relative) ||
    actual === path.join(realRoot(root, true), relative)
  );
}

export const DescriptorPath = {
  available,
  opened,
  /** The path that reaches descriptor `fd`'s file again, where `available`. */
  of: (fd: number) => `/proc/self/fd/${fd}`,
} as const;
