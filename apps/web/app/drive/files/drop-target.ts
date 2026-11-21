import { DriveRoot } from "@nimbus/api/drive-root";
import type { FileEntry } from "./types";

/**
 * A folder something can be dropped on, wherever it shows: a folder row, a breadcrumb, or any
 * other place that names a folder. Only its path and whether the account may write to it matter.
 */
export type DropTarget = { path: string; writable: boolean };

/** What is being dragged: items from a listing, or files from the computer. */
export type DragPayload =
  | { kind: "entries"; sources: readonly FileEntry[] }
  | { kind: "files" };

/** Whether a drop on a target is taken, and if not, why. */
export type DropVerdict =
  | { kind: "move" }
  | { kind: "upload" }
  | {
      kind: "refused";
      reason: "read-only" | "itself" | "inside-itself" | "already-there";
    };

const parentOf = (path: string) => path.split("/").slice(0, -1).join("/");

function verdict(payload: DragPayload, target: DropTarget): DropVerdict {
  if (!target.writable) return { kind: "refused", reason: "read-only" };
  if (payload.kind === "files") return { kind: "upload" };
  const { sources } = payload;
  if (sources.some((source) => source.path === target.path))
    return { kind: "refused", reason: "itself" };
  if (sources.some((source) => target.path.startsWith(`${source.path}/`)))
    return { kind: "refused", reason: "inside-itself" };
  if (sources.some((source) => parentOf(source.path) === target.path))
    return { kind: "refused", reason: "already-there" };
  return { kind: "move" };
}

/** What the pointer says over a target: where things go, or why they cannot. */
function hint(result: DropVerdict, target: DropTarget) {
  const name = `“${DriveRoot.nameOf(target.path)}”`;
  switch (result.kind) {
    case "move":
      return `Move to ${name}`;
    case "upload":
      return `Upload to ${name}`;
    case "refused":
      switch (result.reason) {
        case "read-only":
          return `You can only view ${name}, so nothing can go there`;
        case "itself":
          return `${name} cannot go into itself`;
        case "inside-itself":
          return `A folder cannot go into a folder inside it`;
        case "already-there":
          return `Already in ${name}`;
      }
  }
}

export const DropTarget = {
  /** A folder row as a target. Files are not targets. */
  ofEntry: (entry: FileEntry): DropTarget | null =>
    entry.type === "dir"
      ? { path: entry.path, writable: entry.permission !== "read" }
      : null,
  verdict,
  hint,
  /** Whether a drop would be taken. */
  accepts: (payload: DragPayload, target: DropTarget) =>
    verdict(payload, target).kind !== "refused",
} as const;
