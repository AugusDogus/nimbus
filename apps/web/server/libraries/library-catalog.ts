import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  realpathSync,
} from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { getDataRoot } from "@nimbus/api/data-root";
import { DescriptorPath } from "@nimbus/api/descriptor-path";
import {
  isFsError,
  isWithinPath,
  PathError,
  resolveSafePath,
} from "@nimbus/api/safe-path";
import { libraries, libraryFolders, libraryItems } from "../db/library-schema";
import { FileVersion } from "../file-version";
import { reconcileIntervalMs } from "../search-protocol";
import { CatalogIdentity, type ScannedFile } from "./catalog-identity";
import { ContentFingerprint } from "./content-fingerprint";
import {
  LibraryAccess,
  type CatalogTarget,
  type LibraryItem,
} from "./library-access";
import type { LibraryContext } from "./library-context";

/**
 * Each library's catalog: the files under its folders, with persistent random ids and added
 * dates. The disk is the truth; the catalog is reconciled with it in one transaction per
 * library, writing only what changed, so a burst of files costs one commit rather than one per
 * file. Changes the file watcher reports mark libraries for a reconcile soon after; a periodic
 * pass, as for the search index, catches anything it missed. How rows follow renamed, moved
 * and returning files is in CatalogIdentity.
 */

/** Items one library may hold. Past this the library is refused, never truncated. */
export const MAX_LIBRARY_ITEMS = 2000;
/** How long a tombstone is kept for a file to come back, and how many one library keeps. */
export const TOMBSTONE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_TOMBSTONES = 2000;
/** How deep folders are read below a library folder. Deeper files are not listed. */
export const MAX_DEPTH = 32;
/** How long after a reported change a library is reconciled, so a burst settles first. */
const settleMs = 2000;

export type CatalogScan =
  | {
      kind: "ok";
      /** The files, each marked whether its folder is scanned for the first time. */
      files: Omit<ScannedFile, "firstScan">[];
      /** Folders that exist, by path, each with the files found under it. */
      folders: Map<string, string[]>;
    }
  | { kind: "too_large" };

/** An opaque revision of a file's content, from its size, modification and change times. */
const versionOf = (stats: { size: number; mtimeMs: number; ctimeMs: number }) =>
  `v1_${createHash("sha256").update(FileVersion.of(stats)).digest("base64url").slice(0, 22)}`;

/** `folders` without any that lie inside another, so overlapping folders list a file once. */
const outermost = (folders: readonly string[]) =>
  folders.filter(
    (folder) =>
      !folders.some((other) => other !== folder && isWithinPath(other, folder)),
  );

/**
 * The folder at drive path `relative`, opened without following a symbolic link and checked to
 * be that very folder: a folder on the way swapped for a link since it was listed would make
 * the descriptor land elsewhere. Its entries are then read through the descriptor (on Linux
 * `/proc/self/fd`), never by name again. Null when it is gone, not a folder, or elsewhere.
 */
function openFolder(root: string, relative: string) {
  const absolute = path.join(root, relative);
  let fd: number;
  try {
    fd = openSync(
      absolute,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
  } catch (error) {
    if (
      isFsError(error, "ENOENT") ||
      isFsError(error, "ENOTDIR") ||
      isFsError(error, "ELOOP") ||
      isFsError(error, "EACCES")
    )
      return null;
    throw error;
  }
  try {
    const stats = fstatSync(fd);
    const there = DescriptorPath.available
      ? DescriptorPath.opened(fd, stats, root, relative)
      : realpathSync(absolute) === path.join(realpathSync(root), relative);
    if (there && stats.isDirectory())
      return {
        listing: DescriptorPath.available ? DescriptorPath.of(fd) : absolute,
        close: () => closeSync(fd),
      };
  } catch (error) {
    closeSync(fd);
    if (isFsError(error, "ENOENT")) return null;
    throw error;
  }
  closeSync(fd);
  return null;
}

/**
 * The regular files under `folders` (in the owner's order), recursively, each folder read
 * through a verified descriptor (see `openFolder`). A folder that is missing, not a folder, or
 * reached through a symbolic link contributes nothing. Symbolic links and hidden files and
 * folders, Nimbus's own `.nimbus` among them, are skipped.
 * Folders deeper than `MAX_DEPTH` below a library folder are not read. Stops once more than
 * `cap` files are found.
 */
async function scan(
  folders: readonly string[],
  {
    cap = MAX_LIBRARY_ITEMS,
    beforeOpen = async () => undefined,
  }: {
    cap?: number;
    /** Tests only: runs before each folder is opened, to change the disk under the scan. */
    beforeOpen?: (relative: string) => Promise<void>;
  } = {},
): Promise<CatalogScan> {
  const root = getDataRoot();
  const files: Omit<ScannedFile, "firstScan">[] = [];
  const found = new Map<string, string[]>();
  for (const folder of outermost(folders)) {
    try {
      await resolveSafePath(folder);
    } catch (error) {
      if (error instanceof PathError) continue;
      throw error;
    }
    const into: string[] = [];
    const pending: [string, number][] = [[folder, 0]];
    let exists = false;
    while (pending.length) {
      const next = pending.pop();
      if (next === undefined) break;
      const [relative, depth] = next;
      await beforeOpen(relative);
      const opened = openFolder(root, relative);
      if (!opened) continue;
      if (relative === folder) exists = true;
      try {
        let entries;
        try {
          entries = await readdir(opened.listing, { withFileTypes: true });
        } catch (error) {
          if (isFsError(error, "ENOENT") || isFsError(error, "EACCES"))
            continue;
          throw error;
        }
        for (const entry of entries) {
          if (entry.name.startsWith(".")) continue;
          const child = `${relative}/${entry.name}`;
          if (entry.isDirectory()) {
            if (depth < MAX_DEPTH) pending.push([child, depth + 1]);
            continue;
          }
          if (!entry.isFile()) continue;
          let stats;
          try {
            stats = await lstat(path.join(opened.listing, entry.name));
          } catch (error) {
            if (isFsError(error, "ENOENT")) continue;
            throw error;
          }
          if (!stats.isFile()) continue;
          files.push({
            path: child,
            version: versionOf(stats),
            sizeBytes: stats.size,
            modifiedAt: Math.floor(stats.mtimeMs),
          });
          into.push(child);
          if (files.length > cap) return { kind: "too_large" };
        }
      } finally {
        opened.close();
      }
    }
    if (exists) found.set(folder, into);
  }
  return { kind: "ok", files, folders: found };
}

const live = (row: { missingSince: number | null }) =>
  row.missingSince === null;

/**
 * Bring library `libraryId`'s catalog in line with a scan, in one transaction (see
 * CatalogIdentity), mark the folders the scan found as scanned, and prune old tombstones.
 * Writes nothing when nothing changed. Returns the live items.
 */
async function reconcile(
  ctx: Pick<LibraryContext, "db" | "now">,
  libraryId: string,
  scanned: Extract<CatalogScan, { kind: "ok" }>,
): Promise<LibraryItem[]> {
  const now = ctx.now();
  const unscanned = new Set(
    ctx.db
      .select({ path: libraryFolders.path })
      .from(libraryFolders)
      .where(
        and(
          eq(libraryFolders.libraryId, libraryId),
          isNull(libraryFolders.scannedAt),
        ),
      )
      .all()
      .map((folder) => folder.path),
  );
  const firstScan = new Set(
    [...scanned.folders]
      .filter(([folder]) => unscanned.has(folder))
      .flatMap(([, files]) => files),
  );
  const rows = ctx.db
    .select()
    .from(libraryItems)
    .where(eq(libraryItems.libraryId, libraryId))
    .all();
  const plan = await CatalogIdentity.plan(
    libraryId,
    rows,
    scanned.files.map((file) => ({
      ...file,
      firstScan: firstScan.has(file.path),
    })),
    now,
    (file) => ContentFingerprint.of(file.path, file),
  );
  const prunable = rows
    .filter((row) => !live(row) && !plan.updates.some((u) => u.id === row.id))
    .sort((a, b) => (b.missingSince ?? 0) - (a.missingSince ?? 0));
  const pruned = [
    ...prunable.filter(
      (row) => (row.missingSince ?? 0) < now - TOMBSTONE_RETENTION_MS,
    ),
    ...prunable.slice(MAX_TOMBSTONES),
  ].map((row) => row.id);
  const scannedFolders = [...scanned.folders.keys()].filter((folder) =>
    unscanned.has(folder),
  );
  const changed =
    plan.inserts.length +
      plan.updates.length +
      plan.deletes.length +
      plan.tombstones.length >
    0;
  // Synchronous, so the transaction commits exactly these statements.
  const committed = ctx.db.transaction((tx) => {
    // Deleted while it was being scanned: its catalog went with it.
    if (
      !tx
        .select({ id: libraries.id })
        .from(libraries)
        .where(eq(libraries.id, libraryId))
        .get()
    )
      return false;
    const removed = [...plan.deletes, ...new Set(pruned)];
    for (let start = 0; start < removed.length; start += 500)
      tx.delete(libraryItems)
        .where(inArray(libraryItems.id, removed.slice(start, start + 500)))
        .run();
    for (let start = 0; start < plan.tombstones.length; start += 500)
      tx.update(libraryItems)
        .set({ missingSince: now })
        .where(
          inArray(libraryItems.id, plan.tombstones.slice(start, start + 500)),
        )
        .run();
    for (const update of plan.updates)
      tx.update(libraryItems)
        .set(update.set)
        .where(eq(libraryItems.id, update.id))
        .run();
    for (let start = 0; start < plan.inserts.length; start += 500)
      tx.insert(libraryItems)
        .values(plan.inserts.slice(start, start + 500))
        .run();
    if (scannedFolders.length)
      tx.update(libraryFolders)
        .set({ scannedAt: now })
        .where(
          and(
            eq(libraryFolders.libraryId, libraryId),
            inArray(libraryFolders.path, scannedFolders),
          ),
        )
        .run();
    if (changed)
      tx.update(libraries)
        .set({ catalogChangedAt: now })
        .where(eq(libraries.id, libraryId))
        .run();
    return true;
  });
  if (!committed) return [];
  return ctx.db
    .select()
    .from(libraryItems)
    .where(
      and(
        eq(libraryItems.libraryId, libraryId),
        isNull(libraryItems.missingSince),
      ),
    )
    .all();
}

/**
 * Compute the fingerprints the live rows of library `libraryId` lack, as new and changed files
 * have, so a later move or return can be recognized. Runs after a reconcile, off the request
 * that caused it, one file at a time, and stores them in one transaction.
 */
async function fingerprintPending(
  ctx: Pick<LibraryContext, "db">,
  libraryId: string,
) {
  const pending = ctx.db
    .select()
    .from(libraryItems)
    .where(
      and(
        eq(libraryItems.libraryId, libraryId),
        isNull(libraryItems.missingSince),
        isNull(libraryItems.fingerprint),
      ),
    )
    .orderBy(asc(libraryItems.firstSeenAt))
    .all();
  const computed: { id: string; version: string; fingerprint: string }[] = [];
  for (const row of pending) {
    const fingerprint = await ContentFingerprint.of(row.path, row);
    if (fingerprint !== null)
      computed.push({ id: row.id, version: row.version, fingerprint });
  }
  if (!computed.length) return;
  ctx.db.transaction((tx) => {
    for (const row of computed)
      // Only for the version it was read for: a file changed meanwhile is read again later.
      tx.update(libraryItems)
        .set({ fingerprint: row.fingerprint })
        .where(
          and(
            eq(libraryItems.id, row.id),
            eq(libraryItems.version, row.version),
          ),
        )
        .run();
  });
}

type Cached = {
  /** The target scanned, as a key: a change of folders makes the entry stale. */
  folders: string;
  scannedAt: number;
  dirty: boolean;
  result: { kind: "ok"; items: LibraryItem[] } | { kind: "too_large" };
};

const cache = new Map<string, Cached>();
const inFlight = new Map<string, Promise<Cached>>();
/** Each library's latest fingerprint pass. */
const background = new Map<string, Promise<void>>();
let settleTimer: ReturnType<typeof setTimeout> | null = null;

const keyOf = (target: CatalogTarget) => target.folders.join("\0");

async function refresh(
  ctx: Pick<LibraryContext, "db" | "now">,
  libraryId: string,
  target: CatalogTarget,
): Promise<Cached> {
  const running = inFlight.get(libraryId);
  if (running) return running;
  const work = (async (): Promise<Cached> => {
    const scanned = await scan(target.folders);
    const entry: Cached = {
      folders: keyOf(target),
      scannedAt: ctx.now(),
      dirty: false,
      result:
        scanned.kind === "ok"
          ? { kind: "ok", items: await reconcile(ctx, libraryId, scanned) }
          : scanned,
    };
    cache.set(libraryId, entry);
    background.set(
      libraryId,
      fingerprintPending(ctx, libraryId).catch((error: unknown) =>
        console.error(
          `Nimbus could not fingerprint a library's files: ${error instanceof Error ? error.name : typeof error}. Moves of those files are not recognized until the next pass.`,
        ),
      ),
    );
    return entry;
  })();
  inFlight.set(libraryId, work);
  try {
    return await work;
  } finally {
    inFlight.delete(libraryId);
  }
}

export const LibraryCatalog = {
  scan,
  reconcile,
  versionOf,

  /**
   * The catalog of library `libraryId` over `target`, reconciled first when the disk may have
   * changed since the last look. Files outside the target are tombstones: never listed,
   * counted or dated into the library's change time.
   */
  async items(
    ctx: Pick<LibraryContext, "db" | "now">,
    libraryId: string,
    target: CatalogTarget,
  ) {
    const cached = cache.get(libraryId);
    const fresh =
      cached &&
      !cached.dirty &&
      cached.folders === keyOf(target) &&
      ctx.now() - cached.scannedAt < reconcileIntervalMs();
    return (fresh ? cached : await refresh(ctx, libraryId, target)).result;
  },

  /**
   * A file or folder at `changed` (absolute, or relative to the data root) changed: libraries
   * whose folders hold it, or lie inside it, are reconciled shortly.
   */
  noteChange(
    ctx: Pick<LibraryContext, "db" | "now" | "drive">,
    changed: string,
  ) {
    const relative = path
      .relative(getDataRoot(), path.resolve(getDataRoot(), changed))
      .split(path.sep)
      .join("/");
    if (relative.startsWith("..")) return;
    let marked = false;
    for (const entry of cache.values())
      if (
        entry.folders
          .split("\0")
          .some(
            (folder) =>
              isWithinPath(folder, relative) || isWithinPath(relative, folder),
          )
      ) {
        entry.dirty = true;
        marked = true;
      }
    if (!marked || settleTimer) return;
    settleTimer = setTimeout(() => {
      settleTimer = null;
      void LibraryCatalog.reconcileDirty(ctx).catch((error: unknown) =>
        console.error(
          `Nimbus could not update a library catalog: ${error instanceof Error ? error.name : typeof error}. Paired devices see the change at their next library request.`,
        ),
      );
    }, settleMs);
    settleTimer.unref?.();
  },

  /** Reconcile library `libraryId` now, such as after its folders changed. */
  async refreshLibrary(
    ctx: Pick<LibraryContext, "db" | "now" | "drive">,
    libraryId: string,
  ) {
    return refresh(
      ctx,
      libraryId,
      await LibraryAccess.targetOf(ctx, libraryId),
    );
  },

  /** Forget library `libraryId`'s cached scan, once it is deleted. */
  forget(libraryId: string) {
    cache.delete(libraryId);
  },

  /** Reconcile every library marked changed. */
  async reconcileDirty(ctx: Pick<LibraryContext, "db" | "now" | "drive">) {
    for (const [libraryId, entry] of cache)
      if (entry.dirty) await LibraryCatalog.refreshLibrary(ctx, libraryId);
  },

  /** Reconcile every library, as at startup and on the search index's reconcile interval. */
  async reconcileAll(ctx: Pick<LibraryContext, "db" | "now" | "drive">) {
    const all = ctx.db.select({ id: libraries.id }).from(libraries).all();
    for (const library of all)
      await LibraryCatalog.refreshLibrary(ctx, library.id);
  },

  /** Wait for every fingerprint pass started so far. */
  async whenIdle() {
    await Promise.all([...inFlight.values()]);
    await Promise.all([...background.values()]);
  },

  /** Forget every cached scan, as a restart would. */
  resetForTest() {
    cache.clear();
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = null;
  },
} as const;
