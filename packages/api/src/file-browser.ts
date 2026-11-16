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

export async function entryAt(requested: string): Promise<FileEntry> {
  const target = await requireExisting(requested);
  return {
    name: target.relative.split("/").pop() || "My Drive",
    path: target.relative,
    type: target.stats.isDirectory() ? "dir" : "file",
    mtime: target.stats.mtimeMs,
    size: target.stats.isDirectory() ? 0 : target.stats.size,
  };
}

/** Names `safePath` refuses: Nimbus's private folder, and names with control characters or backslashes. */
const unservable = (name: string) =>
  name.toLowerCase() === ".nimbus" || /[\x00-\x1f\\]/.test(name);

/** Children stated at once; enough to keep the filesystem busy without flooding it. */
const statBatch = 256;

/**
 * The browsable files and folders directly inside a folder. The folder's own
 * path is validated once; each child is read with lstat, which never follows
 * a symlink, so symlinks and special files are skipped even if one replaces a
 * child while the folder is listed.
 */
export async function readDirectory(
  requested: string,
  access: Pick<Access, "canBrowse">,
): Promise<FileEntry[]> {
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
  const results: FileEntry[] = [];
  for (let start = 0; start < children.length; start += statBatch) {
    const batch = await Promise.all(
      children.slice(start, start + statBatch).map(async (child) => {
        try {
          const stats = await lstat(path.join(target.absolute, child.name));
          if (stats.isDirectory())
            return {
              ...child,
              type: "dir",
              mtime: stats.mtimeMs,
              size: 0,
            } as const;
          if (stats.isFile())
            return {
              ...child,
              type: "file",
              mtime: stats.mtimeMs,
              size: stats.size,
            } as const;
          return null;
        } catch (error) {
          // The filesystem can change while we list it. Skip removed entries,
          // while preserving actual I/O failures for the caller.
          if (isFsError(error, "ENOENT") || isFsError(error, "ENOTDIR"))
            return null;
          throw error;
        }
      }),
    );
    for (const entry of batch) if (entry) results.push(entry);
  }
  return results;
}
