import { TRPCError } from "@trpc/server";
import path from "node:path";
import type { Access } from "@nimbus/api/access";
import { readDirectory } from "@nimbus/api/file-browser";
import { numberedName } from "@nimbus/api/numbered-name";
import { requireExisting, safePath } from "@nimbus/api/file-operations";
import { getDataRoot } from "@nimbus/api/data-root";
import { DriveRoot } from "@nimbus/api/drive-root";

/**
 * The access an archive is read with, as of now: it checks again that the session, link or
 * connection that started the download is still valid and returns the account's current
 * permissions, or throws once they are gone. A folder download can run for hours, also on a
 * server that is draining, so it asks before every folder it lists and every file it adds.
 */
export type ArchiveAccess = () => Promise<Access>;

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
    const base = path.posix.basename(target.relative) || DriveRoot.label;
    // Items from different folders can share a name. Number them like the browser would.
    let name = base;
    for (let index = 1; used.has(name.toLowerCase()); index++)
      name = numberedName(base, index, !isDirectory);
    used.add(name.toLowerCase());
    roots.push({ relative: target.relative, name, isDirectory });
  }
  return roots;
}

/** The contents of one folder, with names relative to it, as a folder download lists them. */
export async function folderRoot(relative: string) {
  const existing = await requireExisting(relative);
  if (!existing.stats.isDirectory())
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Choose a folder for ZIP download.",
    });
  return [{ relative, name: "", isDirectory: true }];
}

/**
 * Walk the requested items breadth first, yielding readable entries. A root
 * named "" contributes its contents at the top level. Removed entries are skipped. Access is
 * checked again before each folder is listed and each file is yielded (and so opened); once it
 * is gone, the walk throws, which ends the archive.
 */
export async function* archiveEntries(
  roots: readonly { relative: string; name: string; isDirectory: boolean }[],
  current: ArchiveAccess,
): AsyncGenerator<ArchiveEntry> {
  const dataRoot = getDataRoot();
  for (const root of roots) {
    (await current()).require(root.relative, "read");
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
    const prefix = root.name ? `${root.name}/` : "";
    if (prefix) yield { type: "dir", name: prefix, mtime: top.stats.mtime };
    const pending = [root.relative];
    for (
      let directory = pending.shift();
      directory !== undefined;
      directory = pending.shift()
    ) {
      // Entries come from lstat inside a validated folder, so they are plain files and folders.
      const listing = await current();
      listing.require(directory, "read");
      for (const entry of await readDirectory(directory, listing)) {
        const access = await current();
        if (!access.can(entry.path, "read")) continue;
        const name = `${prefix}${root.relative ? entry.path.slice(root.relative.length + 1) : entry.path}`;
        if (entry.type === "dir") {
          yield { type: "dir", name: `${name}/`, mtime: new Date(entry.mtime) };
          pending.push(entry.path);
          continue;
        }
        yield {
          type: "file",
          name,
          absolute: path.join(dataRoot, entry.path),
          size: entry.size,
          mtime: new Date(entry.mtime),
        };
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
