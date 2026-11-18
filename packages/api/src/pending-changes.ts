import type { Stats } from "node:fs";
import { lstat } from "node:fs/promises";
import path from "node:path";
import type { DriveStore, PendingChange } from "./drive-store";
import { isFsError } from "./safe-path";

/**
 * Changes that touch both the filesystem and the database cannot commit both at once. Moving
 * an item to trash records it and then renames it; restoring renames it back and then
 * reattaches its sharing; a move renames and then relocates sharing and history. A crash
 * between the two steps would leave a trash record for a live file, or content whose sharing
 * stayed at its old path. So each of these records a pending change before its filesystem
 * step and removes it with its last step, and `recover`, run at startup before any request,
 * finishes or undoes every change left behind, judging from what is on disk.
 *
 * Version saves need no record: the version's record is written before the rename that
 * replaces the file, so a crash leaves at worst a version identical to the current content.
 */

const trashMarker = (trashId: string) => `trash:${trashId}`;
const restoreMarker = (trashId: string) => `restore:${trashId}`;

const trashedAt = (dataRoot: string, trashId: string) =>
  path.join(dataRoot, ".nimbus", "trash", trashId);

/**
 * An item's device and inode, recorded with its pending change. A rename keeps both, so after
 * a crash the item is recognised wherever it ended up, and other content that another program
 * put there meanwhile is not mistaken for it. Where inodes are not stable across restarts, such
 * as Unraid user shares, recovery then reports the change as unclear and leaves its records.
 */
const identityOf = (stats: Pick<Stats, "dev" | "ino">) =>
  `${stats.dev}:${stats.ino}`;

/** Whether the item recorded as `identity` is at `absolute`. */
async function holds(absolute: string, identity: string) {
  try {
    return identityOf(await lstat(absolute)) === identity;
  } catch (error) {
    if (isFsError(error, "ENOENT") || isFsError(error, "ENOTDIR")) return false;
    throw error;
  }
}

async function exists(absolute: string) {
  try {
    await lstat(absolute);
    return true;
  } catch (error) {
    if (isFsError(error, "ENOENT") || isFsError(error, "ENOTDIR")) return false;
    throw error;
  }
}

export type Recovery = {
  change: PendingChange;
  /**
   * `finished`: the filesystem step had happened and the database step was completed now.
   * `undone`: the filesystem step had not happened and the database step was reverted or
   * never needed. `unclear`: the item was found at neither place, or at both, or other
   * content stands where it was, for example because another program changed it meanwhile;
   * the records were left as they are.
   */
  outcome: "finished" | "undone" | "unclear";
};

async function recoverOne(
  store: DriveStore,
  dataRoot: string,
  change: PendingChange,
): Promise<Recovery["outcome"]> {
  if (change.kind === "move") {
    const [from, to] = await Promise.all([
      holds(path.join(dataRoot, change.from), change.identity),
      holds(path.join(dataRoot, change.to), change.identity),
    ]);
    if (!from && to) {
      // Settles the record in the same transaction, so this never runs twice.
      await store.movePath(change.from, change.to, change.id);
      return "finished";
    }
    await store.removePendingChange(change.id);
    return from && !to ? "undone" : "unclear";
  }
  const item = await store.getTrash(change.trashId);
  const trashed = await exists(trashedAt(dataRoot, change.trashId));
  const original =
    item !== null &&
    (await holds(path.join(dataRoot, item.path), change.identity));
  let outcome: Recovery["outcome"];
  if (change.kind === "trash") {
    if (trashed) outcome = "finished";
    else if (original) {
      // The item never reached trash: give its sharing back.
      await store.restoreTrash(change.trashId);
      outcome = "undone";
    } else outcome = "unclear";
  } else if (trashed) outcome = "undone";
  else if (original) {
    // The item is back at its path: reattach its sharing, as the restore would have.
    await store.restoreTrash(change.trashId);
    outcome = "finished";
  } else outcome = "unclear";
  await store.removePendingChange(change.id);
  return outcome;
}

/** Finish or undo every change a crash interrupted. Run before serving any request. */
async function recover(
  store: DriveStore,
  dataRoot: string,
): Promise<Recovery[]> {
  const recovered: Recovery[] = [];
  for (const change of await store.listPendingChanges())
    recovered.push({
      change,
      outcome: await recoverOne(store, dataRoot, change),
    });
  return recovered;
}

/** One line per recovered change, for the server log. */
function describe({ change, outcome }: Recovery) {
  const what =
    change.kind === "move"
      ? `moving ${change.from} to ${change.to}`
      : `${change.kind === "trash" ? "moving to trash" : "restoring"} trash item ${change.trashId}`;
  switch (outcome) {
    case "finished":
      return `Nimbus finished ${what}, which was interrupted, probably by a crash. Its links, grants and history now follow the item.`;
    case "undone":
      return `Nimbus undid ${what}, which was interrupted before the item moved. The item and its sharing are as they were.`;
    case "unclear":
      return `Nimbus could not tell how far ${what} got before it was interrupted: the item is at neither place, or at both. Its records were left unchanged; check the item and its sharing.`;
  }
}

export const PendingChanges = {
  identityOf,
  trashMarker,
  restoreMarker,
  recover,
  describe,
} as const;
