import { BreadcrumbTrail } from "./breadcrumb-trail";
import type { FileEntry } from "./types";

/**
 * A folder something can be dropped on, wherever it shows: a folder row, a breadcrumb, or any
 * other place that names a folder. Only its path and whether the account may write to it matter.
 */
export type DropTarget = { path: string; writable: boolean };

/**
 * What is being dragged: items from a listing, with how many of the selection were left out
 * because they cannot be moved, or files from the computer.
 */
export type DragPayload =
  | { kind: "entries"; sources: readonly FileEntry[]; skipped: number }
  | { kind: "files" };

/**
 * Why a folder cannot take the items:
 * - `read-only`: the account can only view it;
 * - `itself`: it is one of the items;
 * - `inside-itself`: it is inside one of the items, which cannot hold itself;
 * - `already-there`: every item is in it already, so moving them there changes nothing.
 */
export type RefusalReason =
  | "read-only"
  | "itself"
  | "inside-itself"
  | "already-there";

/**
 * Whether a folder takes what is offered, and if not, why: a drop on a row or a breadcrumb,
 * or a destination in the move and copy picker.
 */
export type DropVerdict =
  | { kind: "move" }
  | { kind: "copy" }
  | { kind: "upload" }
  | { kind: "refused"; reason: RefusalReason };

const parentOf = (path: string) => path.split("/").slice(0, -1).join("/");

/**
 * Whether `target` takes `sources` by `operation`. Items from several folders, as search finds
 * them, can go into one of those folders: only those not already there move.
 */
function forItems(
  operation: "move" | "copy",
  sources: readonly { path: string }[],
  target: DropTarget,
): DropVerdict {
  if (!target.writable) return { kind: "refused", reason: "read-only" };
  if (sources.some((source) => source.path === target.path))
    return { kind: "refused", reason: "itself" };
  if (sources.some((source) => target.path.startsWith(`${source.path}/`)))
    return { kind: "refused", reason: "inside-itself" };
  if (
    operation === "move" &&
    sources.length > 0 &&
    sources.every((source) => parentOf(source.path) === target.path)
  )
    return { kind: "refused", reason: "already-there" };
  return { kind: operation };
}

/** What dropping `payload` on `target` does; items move unless `operation` copies them. */
function verdict(
  payload: DragPayload,
  target: DropTarget,
  operation: "move" | "copy" = "move",
): DropVerdict {
  if (payload.kind === "files")
    return target.writable
      ? { kind: "upload" }
      : { kind: "refused", reason: "read-only" };
  return forItems(operation, payload.sources, target);
}

/** `sources` without those already in the folder at `path`, which a move there leaves alone. */
const notIn = <T extends { path: string }>(
  sources: readonly T[],
  path: string,
) => sources.filter((source) => parentOf(source.path) !== path);

/**
 * What the pointer says over a target: where things go, or why they cannot. The target is named
 * as the breadcrumb names it for an account whose top folder is `top`; `subject`, such as
 * “a.txt” or "3 items", names what moves or copies.
 */
function hint(
  result: DropVerdict,
  target: DropTarget,
  top: string,
  subject?: string,
) {
  const name = `“${BreadcrumbTrail.name(target.path, top)}”`;
  const what = subject ? ` ${subject}` : "";
  switch (result.kind) {
    case "move":
      return `Move${what} to ${name}`;
    case "copy":
      return `Copy${what} to ${name}`;
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

/**
 * Says that some of the items are in the target already and stay there while the others
 * move, or null when none are, or all are (which `verdict` refuses).
 */
function alreadyThere(
  sources: readonly { path: string }[],
  target: DropTarget,
  top: string,
) {
  const staying = sources.length - notIn(sources, target.path).length;
  if (staying === 0 || staying === sources.length) return null;
  const name = `“${BreadcrumbTrail.name(target.path, top)}”`;
  return `${staying.toLocaleString()} of ${sources.length.toLocaleString()} items ${staying === 1 ? "is" : "are"} already in ${name} and ${staying === 1 ? "stays" : "stay"} there`;
}

/** Says that part of a selection stays where it is, or null when all of it is dragged. */
function leftBehind({
  dragged,
  skipped,
}: {
  dragged: number;
  skipped: number;
}) {
  if (skipped === 0) return null;
  const total = dragged + skipped;
  return `${skipped.toLocaleString()} of ${total.toLocaleString()} items cannot be moved from here`;
}

/** “a.txt”, or "3 items": what a drag of `sources` carries. */
function subjectOf(sources: readonly { name: string }[]) {
  const [only, ...others] = sources;
  return only && others.length === 0
    ? `“${only.name}”`
    : `${sources.length.toLocaleString()} items`;
}

/**
 * The hint while something is dragged, over the folder `over` or none. A drag of items says
 * what a drop there does, and that Esc cancels it, from the moment it starts; files from the
 * computer only where they would go.
 */
function dragText(
  payload: DragPayload,
  over: { target: DropTarget; verdict: DropVerdict } | null,
  top: string,
) {
  if (payload.kind === "files")
    return over ? hint(over.verdict, over.target, top) : "";
  const subject = subjectOf(payload.sources);
  return `${[
    over
      ? hint(over.verdict, over.target, top, subject)
      : `Drop on a folder to move ${subject}`,
    over?.verdict.kind === "move"
      ? alreadyThere(payload.sources, over.target, top)
      : null,
    leftBehind({ dragged: payload.sources.length, skipped: payload.skipped }),
  ]
    .filter(Boolean)
    .join(". ")} · Esc to cancel`;
}

export const DropTarget = {
  dragText,
  leftBehind,
  alreadyThere,
  /** A folder row as a target. Files are not targets. */
  ofEntry: (entry: FileEntry): DropTarget | null =>
    entry.type === "dir"
      ? { path: entry.path, writable: entry.permission !== "read" }
      : null,
  verdict,
  forItems,
  notIn,
  hint,
  /** Whether a drop would be taken. */
  accepts: (
    payload: DragPayload,
    target: DropTarget,
    operation: "move" | "copy" = "move",
  ) => verdict(payload, target, operation).kind !== "refused",
} as const;
