import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import type { Access } from "./access";
import { requireExisting, safePath } from "./file-operations";
import { isFsError } from "./safe-path";

export type FileEntry = {
  name: string;
  path: string;
  type: "dir" | "file";
  mtime: number;
  size: number;
};

/** An entry as read from disk, with the creation time WebDAV reports. */
export type StatedEntry = FileEntry & {
  /** Birth time, or the modification time on filesystems that do not record it. */
  createdMs: number;
};

const createdMs = (stats: { birthtimeMs: number; mtimeMs: number }) =>
  stats.birthtimeMs || stats.mtimeMs;

export async function entryAt(requested: string): Promise<StatedEntry> {
  const target = await requireExisting(requested);
  return {
    name: target.relative.split("/").pop() || "My Drive",
    path: target.relative,
    type: target.stats.isDirectory() ? "dir" : "file",
    mtime: target.stats.mtimeMs,
    size: target.stats.isDirectory() ? 0 : target.stats.size,
    createdMs: createdMs(target.stats),
  };
}

/** Names `safePath` refuses: Nimbus's private folder, and names with control characters or backslashes. */
const unservable = (name: string) =>
  name.toLowerCase() === ".nimbus" || /[\x00-\x1f\\]/.test(name);

/**
 * Children stated at once. Measured at 50,000 entries: about as fast as stating
 * all at once, with a 3 ms longest event-loop pause instead of 88 ms.
 */
const statConcurrency = 64;

/**
 * The browsable files and folders directly inside a folder. The folder's own
 * path is validated once; each child is read with lstat, which never follows
 * a symlink, so symlinks and special files are skipped even if one replaces a
 * child while the folder is listed.
 */
export async function readDirectory(
  requested: string,
  access: Pick<Access, "canBrowse">,
): Promise<StatedEntry[]> {
  const target = await safePath(requested);
  const children = (await readdir(target.absolute, { withFileTypes: true }))
    .filter(
      (entry) =>
        (entry.isFile() || entry.isDirectory()) && !unservable(entry.name),
    )
    .map((entry) => ({
      name: entry.name,
      path: target.relative ? `${target.relative}/${entry.name}` : entry.name,
    }))
    .filter((child) => access.canBrowse(child.path));
  const stated: (StatedEntry | null)[] = Array.from(
    { length: children.length },
    () => null,
  );
  let next = 0;
  const statNext = async () => {
    for (let index = next++; index < children.length; index = next++) {
      const child = children[index];
      if (!child) continue;
      try {
        const stats = await lstat(path.join(target.absolute, child.name));
        if (stats.isDirectory() || stats.isFile())
          stated[index] = {
            ...child,
            type: stats.isDirectory() ? "dir" : "file",
            mtime: stats.mtimeMs,
            size: stats.isDirectory() ? 0 : stats.size,
            createdMs: createdMs(stats),
          };
      } catch (error) {
        // The filesystem can change while we list it. Skip removed entries,
        // while preserving actual I/O failures for the caller.
        if (!isFsError(error, "ENOENT") && !isFsError(error, "ENOTDIR"))
          throw error;
      }
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(statConcurrency, children.length) },
      statNext,
    ),
  );
  const results = stated.filter((entry) => entry !== null);
  return results;
}
