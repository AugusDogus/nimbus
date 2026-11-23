import { randomBytes } from "node:crypto";
import type { libraryItems } from "../db/library-schema";

/**
 * How a library's catalog rows follow its files from one scan to the next, without reading
 * any file's content:
 *
 * - A file at a path with a live row is that row. A changed file gets a new version.
 * - A row whose file vanished becomes a tombstone: never listed or reachable.
 * - A file appearing at a path with exactly one tombstone of the same size and modification
 *   time takes that row back, live again, as when a folder was briefly unavailable. Otherwise
 *   it is a new item.
 *
 * Renames and moves made through Nimbus carry rows along (see DriveStore.movePath). Renames
 * made outside Nimbus produce a new item. Only files the scan found inside the folders the
 * library currently offers are matched, so this never makes anything reachable that was not.
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

export type CatalogPlan = {
  inserts: CatalogRow[];
  /** Rows to change, by id. */
  updates: { id: string; set: Partial<CatalogRow> }[];
  /** Rows whose file vanished. */
  tombstones: string[];
};

/** What to change so library `libraryId`'s rows, tombstones included, match `files`. */
function plan(
  libraryId: string,
  rows: readonly CatalogRow[],
  files: readonly ScannedFile[],
  now: number,
): CatalogPlan {
  const result: CatalogPlan = { inserts: [], updates: [], tombstones: [] };
  const live = new Map(
    rows
      .filter((row) => row.missingSince === null)
      .map((row) => [row.path, row]),
  );
  const tombstones = rows.filter((row) => row.missingSince !== null);
  const present = new Set(files.map((file) => file.path));
  for (const row of live.values())
    if (!present.has(row.path)) result.tombstones.push(row.id);
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
      result.updates.push({
        id: returning.id,
        set: { version: file.version, missingSince: null },
      });
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
  return result;
}

export const CatalogIdentity = { plan } as const;
