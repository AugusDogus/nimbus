import { readdir } from "node:fs/promises";
import type { Access } from "./access";
import { requireExisting, safePath } from "./file-operations";
import { isApiError } from "./safe-path";

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

export async function readDirectory(
  requested: string,
  access: Pick<Access, "canBrowse">,
): Promise<FileEntry[]> {
  const target = await safePath(requested);
  const entries = await readdir(target.absolute, { withFileTypes: true });
  const results: FileEntry[] = [];
  for (const entry of entries) {
    if (
      entry.name.toLowerCase() === ".nimbus" ||
      (!entry.isFile() && !entry.isDirectory())
    )
      continue;
    const childPath = target.relative
      ? `${target.relative}/${entry.name}`
      : entry.name;
    if (!access.canBrowse(childPath)) continue;
    try {
      results.push(await entryAt(childPath));
    } catch (error) {
      // The filesystem can change while we list it. Skip removed or inaccessible
      // entries, while preserving actual I/O failures for the caller.
      if (
        !isApiError(error, "NOT_FOUND") &&
        !isApiError(error, "FORBIDDEN") &&
        !isApiError(error, "BAD_REQUEST")
      )
        throw error;
    }
  }
  return results;
}
