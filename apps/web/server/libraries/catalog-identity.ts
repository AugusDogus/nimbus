import { randomBytes } from "node:crypto";
import type { libraryItems } from "../db/library-schema";
import type { ContentFingerprint } from "./content-fingerprint";

/**
 * How a library's catalog rows follow its files from one scan to the next, so an item keeps its
 * id and added date through renames and moves, also ones made outside
 * Nimbus, without ever guessing:
 *
 * - A file at a path with a live row is that row. A changed file gets a new version and its
 *   fingerprint is recomputed.
 * - A row whose file vanished becomes a tombstone: never listed or reachable.
 * - A file new to the catalog takes over a tombstone, live again at the file's path, only when
 *   exactly one tombstone of this library has the same size, modification time and content
 *   fingerprint, and no other new file matches that tombstone. Otherwise it is a new item.
 * - A copy made before its original is deleted, as moves across disks are: when a row vanishes
 *   and exactly one other row of this library, first seen within the last hour, has the same
 *   size, modification time and fingerprint, that newer row is dropped and the older one takes
 *   its path.
 *
 * Only files the scan found inside the library's folders are matched, so this never makes
 * anything reachable that was not; reachability is still decided by LibraryAccess.
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
  /** Rows to change, by id; a row taking a path is changed after `deletes`. */
  updates: { id: string; set: Partial<CatalogRow> }[];
  /** Newer duplicate rows merged into their originals. */
  deletes: string[];
  /** Rows whose file vanished. */
  tombstones: string[];
};

/** A newer copy merges into its original only if it was first seen this recently. */
export const COPY_WINDOW_MS = 60 * 60 * 1000;

const sameFile = (
  a: { sizeBytes: number; modifiedAt: number; fingerprint: string | null },
  b: { sizeBytes: number; modifiedAt: number; fingerprint: string | null },
) =>
  a.fingerprint !== null &&
  a.fingerprint === b.fingerprint &&
  a.sizeBytes === b.sizeBytes &&
  a.modifiedAt === b.modifiedAt;

/**
 * What to change so library `libraryId`'s rows match `files`. `fingerprintOf` reads a new
 * file's fingerprint; it is asked only for files whose size and modification time match a
 * tombstone, so a scan reads file contents only when a match is possible.
 */
async function planCatalog(
  libraryId: string,
  rows: readonly CatalogRow[],
  files: readonly ScannedFile[],
  now: number,
  fingerprintOf: (file: ScannedFile) => Promise<ContentFingerprint | null>,
): Promise<CatalogPlan> {
  const plan: CatalogPlan = {
    inserts: [],
    updates: [],
    deletes: [],
    tombstones: [],
  };
  const live = new Map(
    rows
      .filter((row) => row.missingSince === null)
      .map((row) => [row.path, row]),
  );
  const present = new Set(files.map((file) => file.path));
  const vanished = [...live.values()].filter((row) => !present.has(row.path));
  const fresh: ScannedFile[] = [];
  /** Live rows whose file is unchanged in this scan: candidates for copy merging. */
  const stable: CatalogRow[] = [];
  for (const file of files) {
    const row = live.get(file.path);
    if (!row) {
      fresh.push(file);
      continue;
    }
    if (
      row.version !== file.version ||
      row.sizeBytes !== file.sizeBytes ||
      row.modifiedAt !== file.modifiedAt
    )
      plan.updates.push({
        id: row.id,
        set: {
          version: file.version,
          sizeBytes: file.sizeBytes,
          modifiedAt: file.modifiedAt,
          fingerprint: null,
        },
      });
    else stable.push(row);
  }

  // Tombstones, including rows vanishing in this scan: a move seen in one scan is both.
  const tombstones = [
    ...rows.filter((row) => row.missingSince !== null),
    ...vanished,
  ].filter((row) => row.fingerprint !== null);
  const matches = new Map<ScannedFile, CatalogRow[]>();
  const claims = new Map<string, number>();
  const fingerprints = new Map<ScannedFile, ContentFingerprint | null>();
  for (const file of fresh) {
    const possible = tombstones.filter(
      (row) =>
        row.sizeBytes === file.sizeBytes && row.modifiedAt === file.modifiedAt,
    );
    if (!possible.length) continue;
    const fingerprint = await fingerprintOf(file);
    fingerprints.set(file, fingerprint);
    const found = possible.filter((row) =>
      sameFile(row, { ...file, fingerprint }),
    );
    matches.set(file, found);
    for (const row of found) claims.set(row.id, (claims.get(row.id) ?? 0) + 1);
  }

  const revived = new Set<string>();
  for (const file of fresh) {
    const [only, ...others] = matches.get(file) ?? [];
    if (only && others.length === 0 && claims.get(only.id) === 1) {
      revived.add(only.id);
      plan.updates.push({
        id: only.id,
        set: {
          path: file.path,
          version: file.version,
          sizeBytes: file.sizeBytes,
          modifiedAt: file.modifiedAt,
          missingSince: null,
        },
      });
      continue;
    }
    plan.inserts.push({
      id: `itm_${randomBytes(16).toString("base64url")}`,
      libraryId,
      path: file.path,
      addedAt: file.firstScan ? Math.min(file.modifiedAt, now) : now,
      firstSeenAt: now,
      version: file.version,
      sizeBytes: file.sizeBytes,
      modifiedAt: file.modifiedAt,
      fingerprint: fingerprints.get(file) ?? null,
      missingSince: null,
    });
  }

  // Vanished rows not taken up by a new file: merge a recent copy into them, or tombstone them.
  const unclaimed = vanished.filter((row) => !revived.has(row.id));
  const copies = new Map<CatalogRow, CatalogRow[]>();
  const copyClaims = new Map<string, number>();
  for (const original of unclaimed) {
    if (original.fingerprint === null) continue;
    const found = stable.filter(
      (copy) =>
        copy.firstSeenAt >= now - COPY_WINDOW_MS &&
        copy.firstSeenAt > original.firstSeenAt &&
        sameFile(copy, original),
    );
    copies.set(original, found);
    for (const copy of found)
      copyClaims.set(copy.id, (copyClaims.get(copy.id) ?? 0) + 1);
  }
  for (const original of unclaimed) {
    const [copy, ...others] = copies.get(original) ?? [];
    if (copy && others.length === 0 && copyClaims.get(copy.id) === 1) {
      plan.deletes.push(copy.id);
      plan.updates.push({
        id: original.id,
        set: {
          path: copy.path,
          version: copy.version,
          sizeBytes: copy.sizeBytes,
          modifiedAt: copy.modifiedAt,
          missingSince: null,
        },
      });
      continue;
    }
    plan.tombstones.push(original.id);
  }
  return plan;
}

export const CatalogIdentity = { plan: planCatalog, COPY_WINDOW_MS } as const;
