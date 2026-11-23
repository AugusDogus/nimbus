import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { and, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
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
import {
  CatalogIdentity,
  type CatalogMove,
  type ScannedFile,
} from "./catalog-identity";
import { HardLinks, type StagedNames } from "./hard-links";
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
      /** Library folders read whole, by path, each with the files found under it. */
      folders: Map<string, string[]>;
      /** Every folder whose entries were read and confirmed to be where they were reached. */
      read: Set<string>;
      /**
       * Every name found in those folders but not listed as a file: folders, and entries skipped
       * (hidden, unreadable, links, a file with other names).
       */
      unlisted: Set<string>;
    }
  | { kind: "too_large" }
  /** This system cannot tell where an open folder is, so folders cannot be read confined. */
  | { kind: "unavailable" };

/**
 * An opaque revision of the file at drive path `relative`, from that path and the file's size,
 * modification and change times. The path is part of it because an id can move to a file at
 * another path (see CatalogIdentity), and moving a folder leaves its files' times unchanged:
 * what was checked or cached for one path never stands for another.
 */
const versionOf = (
  relative: string,
  stats: { size: number; mtimeMs: number; ctimeMs: number },
) =>
  `v1_${createHash("sha256")
    .update(`${relative}\0${FileVersion.of(stats)}`)
    .digest("base64url")
    .slice(0, 22)}`;

/**
 * The file a request opened for an item: its path, and the versions that name it, the
 * catalog's at the time and the opened file's own (the catalog may not have seen an edit yet).
 */
export type OpenedSource = { path: string; versions: readonly string[] };

const sourceOf = (
  item: LibraryItem,
  stats: { size: number; mtimeMs: number; ctimeMs: number },
): OpenedSource => ({
  path: item.path,
  versions: [item.version, versionOf(item.path, stats)],
});

/** Whether catalog row `item` still names `source`, rather than a file its id moved to since. */
const names = (item: LibraryItem, source: OpenedSource) =>
  item.path === source.path && source.versions.includes(item.version);

/** `folders` without any that lie inside another, so overlapping folders list a file once. */
const outermost = (folders: readonly string[]) =>
  folders.filter(
    (folder) =>
      !folders.some((other) => other !== folder && isWithinPath(other, folder)),
  );

/** Paths already reported unreadable, so each is logged once per process. */
const reported = new Set<string>();

/** Report that `relative` could not be read and was skipped, once per path and cause. */
function skipped(relative: string, error: unknown) {
  const code =
    error instanceof Error && "code" in error && typeof error.code === "string"
      ? error.code
      : "unknown";
  const key = `${code}\0${relative}`;
  if (reported.has(key)) return;
  reported.add(key);
  console.warn(
    `Nimbus skipped "${relative}" in a library because it cannot be read (${code}). The rest of the library is listed. Check the permissions of that file or folder on the server.`,
  );
}

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
      !isFsError(error, "ENOENT") &&
      !isFsError(error, "ENOTDIR") &&
      !isFsError(error, "ELOOP")
    )
      skipped(relative, error);
    return null;
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
    if (!isFsError(error, "ENOENT")) skipped(relative, error);
    return null;
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
  /** Upload staging's names, read once a file with several names is found. */
  let staged: StagedNames | undefined;
  const files: Omit<ScannedFile, "firstScan">[] = [];
  const found = new Map<string, string[]>();
  const read = new Set<string>();
  const unlisted = new Set<string>();
  for (const folder of outermost(folders)) {
    try {
      await resolveSafePath(folder);
    } catch (error) {
      if (!(error instanceof PathError)) skipped(folder, error);
      continue;
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
      try {
        await afterOpen(relative);
        let entries;
        try {
          entries = await readdir(opened.listing, { withFileTypes: true });
        } catch (error) {
          if (!isFsError(error, "ENOENT")) skipped(relative, error);
          continue;
        }
        const children: [string, number][] = [];
        const listed: Omit<ScannedFile, "firstScan">[] = [];
        const here: string[] = [];
        for (const entry of entries) {
          const child = `${relative}/${entry.name}`;
          here.push(child);
          if (entry.name.startsWith(".")) continue;
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
            if (!isFsError(error, "ENOENT")) skipped(child, error);
            continue;
          }
          if (!stats.isFile()) continue;
          if (stats.nlink > 1) {
            staged ??= await HardLinks.staged(root);
            if (!HardLinks.offered(stats, staged)) continue;
          }
          listed.push({
            path: child,
            version: versionOf(child, stats),
            sizeBytes: stats.size,
            modifiedAt: Math.floor(stats.mtimeMs),
          });
        }
        // A folder moved elsewhere while it was read listed someone else's entries.
        if (!opened.stillThere()) continue;
        read.add(relative);
        const kept = new Set(listed.map((entry) => entry.path));
        for (const name of here) if (!kept.has(name)) unlisted.add(name);
        if (relative === folder) exists = true;
        pending.push(...children);
        for (const entry of listed) {
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
  return { kind: "ok", files, folders: found, read, unlisted };
}

/** Library `libraryId`'s live rows, as they stand. */
const liveRows = (ctx: Pick<LibraryContext, "db">, libraryId: string) =>
  ctx.db
    .select()
    .from(libraryItems)
    .where(
      and(
        eq(libraryItems.libraryId, libraryId),
        isNull(libraryItems.missingSince),
      ),
    )
    .all();

const live = (row: { missingSince: number | null }) =>
  row.missingSince === null;

/**
 * Whether the file a row had at `relative` is known to be gone by this scan: the nearest folder
 * on its path that was read in full has no unlisted entry by the name that leads to it. Such an
 * entry is the file itself, skipped, or a folder that was not read (skipped, replaced while it
 * was read, too deep): either way the file may still be there.
 */
function gone(scanned: Extract<CatalogScan, { kind: "ok" }>, relative: string) {
  for (
    let name = relative, folder = path.posix.dirname(relative);
    folder !== name;
    name = folder, folder = path.posix.dirname(folder)
  )
    if (scanned.read.has(folder)) return !scanned.unlisted.has(name);
  return false;
}

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
  const all = ctx.db
    .select()
    .from(libraryItems)
    .where(eq(libraryItems.libraryId, libraryId))
    .all();
  // Expired tombstones go before anything is matched, so none is ever taken back.
  const expired = all
    .filter(
      (row) =>
        row.missingSince !== null &&
        row.missingSince < now - TOMBSTONE_RETENTION_MS,
    )
    .map((row) => row.id);
  const rows = all.filter((row) => !expired.includes(row.id));
  const plan = CatalogIdentity.plan(
    libraryId,
    rows,
    scanned.files.map((file) => ({
      ...file,
      firstScan: firstScan.has(file.path),
    })),
    // Only a row whose file is known gone may pass to another file.
    (row) => gone(scanned, row),
    now,
  );
  // The count limit covers every tombstone after this pass, the newest kept first.
  const revived = new Set([
    ...plan.updates
      .filter((update) => update.set.missingSince === null)
      .map((update) => update.id),
    ...plan.moves.map((move) => move.id),
  ]);
  const tombstones = [
    ...plan.tombstones,
    ...rows
      .filter((row) => !live(row) && !revived.has(row.id))
      .sort((a, b) => (b.missingSince ?? 0) - (a.missingSince ?? 0))
      .map((row) => row.id),
  ];
  const overflow = new Set(tombstones.slice(MAX_TOMBSTONES));
  const pruned = [...expired, ...overflow];
  const vanished = plan.tombstones.length;
  plan.tombstones = plan.tombstones.filter((id) => !overflow.has(id));
  const scannedFolders = [...scanned.folders.keys()].filter((folder) =>
    unscanned.has(folder),
  );
  const changed =
    plan.inserts.length + plan.updates.length + plan.moves.length + vanished >
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
    const removed = pruned;
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
    // Moves in a few statements, each row's new path and version chosen by its id.
    for (let start = 0; start < plan.moves.length; start += 200) {
      const chunk = plan.moves.slice(start, start + 200);
      const byId = (value: (move: CatalogMove) => string): SQL =>
        sql`CASE ${libraryItems.id} ${sql.join(
          chunk.map((move) => sql`WHEN ${move.id} THEN ${value(move)}`),
          sql` `,
        )} END`;
      tx.update(libraryItems)
        .set({
          path: byId((move) => move.path),
          version: byId((move) => move.version),
          missingSince: null,
        })
        .where(
          inArray(
            libraryItems.id,
            chunk.map((move) => move.id),
          ),
        )
        .run();
    }
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
  return liveRows(ctx, libraryId);
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
  ctx: Pick<LibraryContext, "db" | "now" | "drive">,
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
    // The folders offered may have changed while the scan ran: one withdrawn must not lend
    // its rows to files found elsewhere, and one added was not read, so committing would
    // tombstone its rows over a fuller scan's. Such a scan is discarded, and the next look
    // scans again. Checked just before reconciling, which commits without waiting on anything.
    if (
      scanned.kind === "ok" &&
      keyOf(await LibraryAccess.targetOf(ctx, libraryId)) !== key
    )
      return {
        folders: key,
        scannedAt: ctx.now(),
        dirty: true,
        result: { kind: "ok", items: liveRows(ctx, libraryId) },
      };
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
  sourceOf,
  names,

  /**
   * The catalog of library `libraryId` over `target`, reconciled first when the disk may have
   * changed since the last look. Files outside the target are tombstones: never listed,
   * counted or dated into the library's change time.
   */
  async items(
    ctx: Pick<LibraryContext, "db" | "now" | "drive">,
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
