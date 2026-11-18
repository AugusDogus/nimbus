import type { BigIntStats } from "node:fs";
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

/** What recovery reads about a path; injectable so tests can reproduce filesystem behaviour. */
type StatAt = (
  absolute: string,
) => Promise<Pick<BigIntStats, "dev" | "ino" | "birthtimeNs" | "mtimeNs">>;
const statAt: StatAt = (absolute) => lstat(absolute, { bigint: true });

/**
 * Which item a pending change moves, recorded before its first step: device, inode and birth
 * time. A rename keeps all three, so after a crash the item is recognised wherever it ended
 * up. The inode alone is not enough: ext4 and xfs give a freed inode number to the next file
 * created, so content another program put in the item's place could carry it. Birth time
 * (statx btime, on ext4, xfs, btrfs and tmpfs) never changes for an item, and content created
 * later gets a later one. Where the filesystem reports none, as some FUSE filesystems do, the
 * modification time stands in: a rename keeps it, and only a program setting it on purpose
 * could match it. A changed reading means other content, so recovery reports the change as
 * unclear and leaves its records, as it also does where inode numbers change across restarts
 * (Unraid user shares).
 *
 * Limits, all failing closed except the first two: content could still pass for the item if
 * the clock stepped back far enough for it to be born in the same timestamp tick as the item,
 * or, without birth times, if a program gave it the item's modification time on purpose. The
 * item itself reads differently, so its change is reported unclear, where renaming copies it
 * up (a lower overlayfs layer) or where statx is refused and Bun reports the change time as
 * the birth time. Records written before birth times were recorded (`dev:ino`, unreleased
 * builds only) match nothing and are reported unclear too.
 */
const identityOf = (
  stats: Pick<BigIntStats, "dev" | "ino" | "birthtimeNs" | "mtimeNs">,
) =>
  stats.birthtimeNs > BigInt(0)
    ? `${stats.dev}:${stats.ino}:born:${stats.birthtimeNs}`
    : `${stats.dev}:${stats.ino}:modified:${stats.mtimeNs}`;

/** The identity of the item now at `absolute`. */
const identityAt = async (absolute: string, stat: StatAt = statAt) =>
  identityOf(await stat(absolute));

/** Whether the item recorded as `identity` is at `absolute`. */
async function holds(absolute: string, identity: string, stat: StatAt) {
  try {
    return identityOf(await stat(absolute)) === identity;
  } catch (error) {
    if (isFsError(error, "ENOENT") || isFsError(error, "ENOTDIR")) return false;
    throw error;
  }
}

async function exists(absolute: string, stat: StatAt) {
  try {
    await stat(absolute);
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
  stat: StatAt,
): Promise<Recovery["outcome"]> {
  if (change.kind === "move") {
    const [from, to] = await Promise.all([
      holds(path.join(dataRoot, change.from), change.identity, stat),
      holds(path.join(dataRoot, change.to), change.identity, stat),
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
  const payload = trashedAt(dataRoot, change.trashId);
  // In trash only as the item itself: other content there is not taken for it.
  const trashed = await holds(payload, change.identity, stat);
  const somethingInTrash = trashed || (await exists(payload, stat));
  const original =
    item !== null &&
    (await holds(path.join(dataRoot, item.path), change.identity, stat));
  // Other content in the item's trash place: restoring it would give that content the item's
  // sharing, so the record stays and blocks restoring until the item is purged.
  if (somethingInTrash && !trashed) return "unclear";
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
  stat: StatAt = statAt,
): Promise<Recovery[]> {
  const recovered: Recovery[] = [];
  for (const change of await store.listPendingChanges())
    recovered.push({
      change,
      outcome: await recoverOne(store, dataRoot, change, stat),
    });
  return recovered;
}

/** Whether a change to trash item `trashId` was interrupted and could not be settled. */
async function blocksRestore(store: DriveStore, trashId: string) {
  return (await store.listPendingChanges()).some(
    (change) => change.kind !== "move" && change.trashId === trashId,
  );
}

/** Forget the unsettled changes of a trash item that is being deleted for good. */
async function forgetTrashItem(
  store: Pick<DriveStore, "removePendingChange">,
  trashId: string,
) {
  await store.removePendingChange(trashMarker(trashId));
  await store.removePendingChange(restoreMarker(trashId));
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
      return `Nimbus could not tell how far ${what} got before it was interrupted: the item is at neither place, at both, or other content stands where it was. Its records were left unchanged; check the item and its sharing. A trash item in this state cannot be restored, only deleted for good.`;
  }
}

export const PendingChanges = {
  identityAt,
  blocksRestore,
  forgetTrashItem,
  trashMarker,
  restoreMarker,
  recover,
  describe,
} as const;
