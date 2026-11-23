import { randomBytes } from "node:crypto";
import type { libraryItems } from "../db/library-schema";

/**
 * How a library's catalog rows follow its files from one scan to the next, without reading
 * any file's content:
 *
 * - A file at a path with a live row is that row. A changed file gets a new version.
 * - A row whose file vanished becomes a tombstone: never listed or reachable.
 * - A file appearing at a path with exactly one tombstone of the same size and modification
 *   time takes that row back, live again, as when a folder was briefly unavailable.
 * - Otherwise, a file appearing at a new path takes over the row of a file that vanished, in
 *   this pass or an earlier one, when it is the only new file with that size (above zero) and
 *   modification time, that row is the only one that vanished with them, and the row's file is
 *   known gone (see LibraryCatalog): never one this scan skipped or could not read. A rename or
 *   move made outside Nimbus.
 * - Otherwise it is a new item.
 *
 * Renames and moves made through Nimbus carry rows along (see DriveStore.movePath). Only files
 * the scan found inside the folders the library currently offers are matched, and only to rows
 * that were inside them too, so this never makes anything reachable that was not.
 */
export type CatalogRow = typeof libraryItems.$inferSelect;

export type ScannedFile = {
  path: string;
  version: string;
  sizeBytes: number;
  modifiedAt: number;
  /** Whether the file's library folder is being scanned for the first time. */
  firstScan: boolean;
};

/** A row that passes to the file at another path, live again. */
export type CatalogMove = { id: string; path: string; version: string };

export type CatalogPlan = {
  inserts: CatalogRow[];
  /** Rows to change, by id. */
  updates: { id: string; set: Partial<CatalogRow> }[];
  moves: CatalogMove[];
  /** Rows whose file vanished. */
  tombstones: string[];
};

/** Size and modification time as one key, or null for an empty file, which is never matched. */
const shapeOf = (entry: { sizeBytes: number; modifiedAt: number }) =>
  entry.sizeBytes > 0 ? `${entry.sizeBytes}:${entry.modifiedAt}` : null;

/** `entries` grouped by `shapeOf`, leaving out empty ones. */
function byShape<T extends { sizeBytes: number; modifiedAt: number }>(
  entries: readonly T[],
) {
  const groups = new Map<string, T[]>();
  for (const entry of entries) {
    const shape = shapeOf(entry);
    if (shape === null) continue;
    const group = groups.get(shape);
    if (group) group.push(entry);
    else groups.set(shape, [entry]);
  }
  return groups;
}

/**
 * What to change so library `libraryId`'s rows, tombstones included, match `files`. Only a row
 * whose path `movable` accepts may pass to a file at another path.
 */
function plan(
  libraryId: string,
  rows: readonly CatalogRow[],
  files: readonly ScannedFile[],
  movable: (path: string) => boolean,
  now: number,
): CatalogPlan {
  const result: CatalogPlan = {
    inserts: [],
    updates: [],
    moves: [],
    tombstones: [],
  };
  const live = new Map(
    rows
      .filter((row) => row.missingSince === null)
      .map((row) => [row.path, row]),
  );
  const tombstones = rows.filter((row) => row.missingSince !== null);
  const present = new Set(files.map((file) => file.path));
  const vanished = [...live.values()].filter((row) => !present.has(row.path));
  const revived = new Set<string>();
  const arrived: ScannedFile[] = [];
  for (const file of files) {
    const row = live.get(file.path);
    if (row) {
      if (
        row.version !== file.version ||
        row.sizeBytes !== file.sizeBytes ||
        row.modifiedAt !== file.modifiedAt
      )
        result.updates.push({
          id: row.id,
          set: {
            version: file.version,
            sizeBytes: file.sizeBytes,
            modifiedAt: file.modifiedAt,
          },
        });
      continue;
    }
    const [returning, ...others] = tombstones.filter(
      (tombstone) =>
        tombstone.path === file.path &&
        tombstone.sizeBytes === file.sizeBytes &&
        tombstone.modifiedAt === file.modifiedAt,
    );
    if (returning && others.length === 0) {
      revived.add(returning.id);
      result.updates.push({
        id: returning.id,
        set: { version: file.version, missingSince: null },
      });
      continue;
    }
    arrived.push(file);
  }
  // Returns at the same path go first; what is left may be renames and moves. Only rows whose
  // files are known gone from what the scan sees count, also for uniqueness: a row in a folder
  // the device cannot see never changes what happens to one it can.
  const gone = byShape(
    [
      ...tombstones.filter((tombstone) => !revived.has(tombstone.id)),
      ...vanished,
    ].filter((row) => movable(row.path)),
  );
  const newcomers = byShape(arrived);
  const moved = new Set<string>();
  for (const file of arrived) {
    const shape = shapeOf(file);
    const candidates = shape === null ? undefined : gone.get(shape);
    const row = candidates?.length === 1 ? candidates[0] : undefined;
    if (
      shape !== null &&
      row !== undefined &&
      newcomers.get(shape)?.length === 1
    ) {
      moved.add(row.id);
      result.moves.push({ id: row.id, path: file.path, version: file.version });
      continue;
    }
    result.inserts.push({
      id: `itm_${randomBytes(16).toString("base64url")}`,
      libraryId,
      path: file.path,
      addedAt: file.firstScan ? Math.min(file.modifiedAt, now) : now,
      version: file.version,
      sizeBytes: file.sizeBytes,
      modifiedAt: file.modifiedAt,
      missingSince: null,
    });
  }
  for (const row of vanished)
    if (!moved.has(row.id)) result.tombstones.push(row.id);
  return result;
}

export const CatalogIdentity = { plan } as const;
