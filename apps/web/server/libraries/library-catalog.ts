import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { and, eq, inArray, isNull } from "drizzle-orm";
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
  | { kind: "too_large" }
  /** This system cannot tell where an open folder is, so folders cannot be read confined. */
  | { kind: "unavailable" };

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
  const there = () => {
    const stats = fstatSync(fd);
    return (
      stats.isDirectory() && DescriptorPath.opened(fd, stats, root, relative)
    );
  };
  try {
    if (there())
      return {
        listing: DescriptorPath.of(fd),
        /** Whether the folder is still where it was reached, as after reading it. */
        stillThere: () => {
          try {
            return there();
          } catch {
            return false;
          }
        },
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
type ScanHooks = {
  /** Runs before each folder is opened, to change the disk under a scan. */
  beforeOpen: (relative: string) => Promise<void>;
  /** Runs once a folder is open and checked, before it is read. */
  afterOpen: (relative: string) => Promise<void>;
};
const noHooks: ScanHooks = {
  beforeOpen: async () => undefined,
  afterOpen: async () => undefined,
};
let scanHooks: ScanHooks = noHooks;

async function scan(
  folders: readonly string[],
  {
    cap = MAX_LIBRARY_ITEMS,
    beforeOpen = scanHooks.beforeOpen,
    afterOpen = scanHooks.afterOpen,
  }: {
    cap?: number;
    /** Tests only: runs before each folder is opened, to change the disk under the scan. */
    beforeOpen?: (relative: string) => Promise<void>;
    afterOpen?: (relative: string) => Promise<void>;
  } = {},
): Promise<CatalogScan> {
  // Reading by path again could follow a folder swapped meanwhile: refuse rather than guess.
  if (!DescriptorPath.available) return { kind: "unavailable" };
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
        await afterOpen(relative);
        let entries;
        try {
          entries = await readdir(opened.listing, { withFileTypes: true });
        } catch (error) {
          if (isFsError(error, "ENOENT") || isFsError(error, "EACCES"))
            continue;
          throw error;
        }
        const children: [string, number][] = [];
        const read: Omit<ScannedFile, "firstScan">[] = [];
        for (const entry of entries) {
          if (entry.name.startsWith(".")) continue;
          const child = `${relative}/${entry.name}`;
          // A name the listing would refuse (see LibraryAccess.reaches) is never counted.
          if (!LibraryAccess.canonical(child)) continue;
          if (entry.isDirectory()) {
            if (depth < MAX_DEPTH) children.push([child, depth + 1]);
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
          read.push({
            path: child,
            version: versionOf(stats),
            sizeBytes: stats.size,
            modifiedAt: Math.floor(stats.mtimeMs),
          });
        }
        // A folder moved elsewhere while it was read listed someone else's entries.
        if (!opened.stillThere()) continue;
        pending.push(...children);
        for (const entry of read) {
          files.push(entry);
          into.push(entry.path);
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
  const plan = CatalogIdentity.plan(
    libraryId,
    rows,
    scanned.files.map((file) => ({
      ...file,
      firstScan: firstScan.has(file.path),
    })),
    now,
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
    plan.inserts.length + plan.updates.length + plan.tombstones.length > 0;
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
    const removed = [...new Set(pruned)];
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

type Cached = {
  /** The target scanned, as a key: a change of folders makes the entry stale. */
  folders: string;
  scannedAt: number;
  dirty: boolean;
  result:
    | { kind: "ok"; items: LibraryItem[] }
    | Exclude<CatalogScan, { kind: "ok" }>;
};

const cache = new Map<string, Cached>();
/** Scans under way, by library and the exact folders scanned: one never stands in for another. */
const inFlight = new Map<string, Promise<Cached>>();
/** The folder keys being scanned for each library, so a change during a scan is noticed. */
const scanning = new Map<string, Set<string>>();
/** Changes reported for each library, counted: a scan a change overtook is not kept as current. */
const changes = new Map<string, number>();
let settleTimer: ReturnType<typeof setTimeout> | null = null;

const keyOf = (target: CatalogTarget) => target.folders.join("\0");

async function refresh(
  ctx: Pick<LibraryContext, "db" | "now">,
  libraryId: string,
  target: CatalogTarget,
): Promise<Cached> {
  const key = keyOf(target);
  const flight = `${libraryId}\0\0${key}`;
  const running = inFlight.get(flight);
  if (running) return running;
  const work = (async (): Promise<Cached> => {
    const before = changes.get(libraryId) ?? 0;
    const scanned = await scan(target.folders);
    const entry: Cached = {
      folders: key,
      scannedAt: ctx.now(),
      dirty: (changes.get(libraryId) ?? 0) !== before,
      result:
        scanned.kind === "ok"
          ? { kind: "ok", items: await reconcile(ctx, libraryId, scanned) }
          : scanned,
    };
    cache.set(libraryId, entry);
    return entry;
  })();
  inFlight.set(flight, work);
  const keys = scanning.get(libraryId) ?? new Set<string>();
  keys.add(key);
  scanning.set(libraryId, keys);
  try {
    return await work;
  } finally {
    inFlight.delete(flight);
    keys.delete(key);
    if (!keys.size) scanning.delete(libraryId);
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
    const touches = (key: string) =>
      key
        .split("\0")
        .some(
          (folder) =>
            isWithinPath(folder, relative) || isWithinPath(relative, folder),
        );
    let marked = false;
    const libraryIds = new Set([...cache.keys(), ...scanning.keys()]);
    for (const libraryId of libraryIds) {
      const entry = cache.get(libraryId);
      const hit =
        (entry !== undefined && touches(entry.folders)) ||
        [...(scanning.get(libraryId) ?? [])].some(touches);
      if (!hit) continue;
      changes.set(libraryId, (changes.get(libraryId) ?? 0) + 1);
      if (entry) entry.dirty = true;
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

  /** Wait for every reconcile under way. */
  async whenIdle() {
    await Promise.all([...inFlight.values()]);
  },

  /** Tests only: run `hooks` in every scan until the returned function restores the defaults. */
  useScanHooksForTest(hooks: Partial<ScanHooks>) {
    const previous = scanHooks;
    scanHooks = { ...noHooks, ...hooks };
    return () => {
      scanHooks = previous;
    };
  },

  /** Forget every cached scan, as a restart would. */
  resetForTest() {
    cache.clear();
    changes.clear();
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = null;
  },
} as const;
