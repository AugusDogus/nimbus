import { TRPCError } from "@trpc/server";
import path from "node:path";
import type { Access } from "@nimbus/api/access";
import { readDirectory } from "@nimbus/api/file-browser";
import { numberedName } from "@nimbus/api/numbered-name";
import { requireExisting, safePath } from "@nimbus/api/file-operations";
import { isApiError } from "@nimbus/api/safe-path";

/** One member of a ZIP: a folder marker or a file read from disk. Names use `/` separators. */
export type ArchiveEntry =
  | { type: "dir"; name: string; mtime: Date }
  | { type: "file"; name: string; absolute: string; size: number; mtime: Date };

/** Validate the requested items up front so permission errors fail the request, not the stream. */
export async function resolveArchiveRoots(
  paths: readonly string[],
  access: Access,
) {
  if (paths.length === 0)
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Choose at least one file or folder to download.",
    });
  const used = new Set<string>();
  const roots: { relative: string; name: string; isDirectory: boolean }[] = [];
  for (const requested of new Set(paths)) {
    const target = await safePath(requested);
    access.require(target.relative, "read");
    const existing = await requireExisting(target.relative);
    const isDirectory = existing.stats.isDirectory();
    const base = path.posix.basename(target.relative) || "My Drive";
    // Items from different folders can share a name. Number them like the browser would.
    let name = base;
    for (let index = 1; used.has(name.toLowerCase()); index++)
      name = numberedName(base, index, !isDirectory);
    used.add(name.toLowerCase());
    roots.push({ relative: target.relative, name, isDirectory });
  }
  return roots;
}

/** Walk the requested items breadth first, yielding readable entries. Removed entries are skipped. */
export async function* archiveEntries(
  roots: Awaited<ReturnType<typeof resolveArchiveRoots>>,
  access: Access,
): AsyncGenerator<ArchiveEntry> {
  for (const root of roots) {
    const top = await requireExisting(root.relative);
    if (!root.isDirectory) {
      yield {
        type: "file",
        name: root.name,
        absolute: top.absolute,
        size: top.stats.size,
        mtime: top.stats.mtime,
      };
      continue;
    }
    yield { type: "dir", name: `${root.name}/`, mtime: top.stats.mtime };
    const pending = [root.relative];
    for (
      let directory = pending.shift();
      directory !== undefined;
      directory = pending.shift()
    ) {
      for (const entry of await readDirectory(directory, access)) {
        if (!access.can(entry.path, "read")) continue;
        const name = `${root.name}/${root.relative ? entry.path.slice(root.relative.length + 1) : entry.path}`;
        if (entry.type === "dir") {
          yield { type: "dir", name: `${name}/`, mtime: new Date(entry.mtime) };
          pending.push(entry.path);
          continue;
        }
        try {
          const file = await requireExisting(entry.path);
          yield {
            type: "file",
            name,
            absolute: file.absolute,
            size: file.stats.size,
            mtime: file.stats.mtime,
          };
        } catch (error) {
          if (!isApiError(error, "NOT_FOUND")) throw error;
        }
      }
    }
  }
}

/** `photos.zip` for one item, otherwise the shared parent folder's name, or `Nimbus download.zip`. */
export function archiveName(
  roots: readonly { relative: string; name: string }[],
) {
  const [first, ...rest] = roots;
  if (first && rest.length === 0) return `${first.name}.zip`;
  const parents = new Set(
    roots.map((root) => path.posix.dirname(root.relative)),
  );
  const [parent] = parents;
  return parents.size === 1 && parent && parent !== "."
    ? `${path.posix.basename(parent)}.zip`
    : "Nimbus download.zip";
}
