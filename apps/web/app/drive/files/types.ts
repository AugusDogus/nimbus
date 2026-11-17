import type { Permission } from "@nimbus/api/drive-store";

export type FileEntry = {
  name: string;
  permission: Permission;
  path: string;
  type: string;
  mtime: number | null;
  size: number | null;
  /** A home folder or one holding homes, which the server never renames, moves or trashes. */
  fixed: boolean;
};

function canMove(entry: FileEntry) {
  return (
    entry.path !== "" &&
    !entry.fixed &&
    (entry.permission === "admin" ||
      (entry.permission === "write" && entry.type !== "dir"))
  );
}

function canMoveInto(source: FileEntry, destination: FileEntry) {
  return (
    canMove(source) &&
    destination.type === "dir" &&
    destination.permission !== "read" &&
    destination.path !== source.path &&
    !destination.path.startsWith(`${source.path}/`) &&
    destination.path !== source.path.split("/").slice(0, -1).join("/")
  );
}

function canTrash(entry: FileEntry) {
  return entry.permission !== "read" && !entry.fixed;
}

/**
 * `entries` without those inside another of them: moving, copying or trashing a folder takes
 * its contents along, and acting on both would conflict.
 */
function outermost<T extends Pick<FileEntry, "path" | "type">>(
  entries: readonly T[],
): T[] {
  const folders = new Set(
    entries.filter((entry) => entry.type === "dir").map((entry) => entry.path),
  );
  return entries.filter((entry) => {
    for (
      let slash = entry.path.lastIndexOf("/");
      slash > 0;
      slash = entry.path.lastIndexOf("/", slash - 1)
    )
      if (folders.has(entry.path.slice(0, slash))) return false;
    return true;
  });
}

export const FileEntry = {
  canMove,
  canMoveInto,
  canTrash,
  outermost,
} as const;

export const fileHref = (path: string) =>
  path ? `/browse/${path.split("/").map(encodeURIComponent).join("/")}` : "/";
