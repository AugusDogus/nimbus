import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  realpathSync,
  type Dirent,
  type Stats,
} from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { DescriptorPath } from "./descriptor-path";
import { isFsError } from "./safe-path";
import type { SearchIndex } from "./search-index";

/**
 * Names browsing hides because `safePath` refuses them (file-browser.ts):
 * Nimbus's private folder, and names with control characters or backslashes.
 */
const unservableName = (name: string) =>
  name.toLowerCase() === ".nimbus" || /[\x00-\x1f\\]/.test(name);

/** Files stated at once per folder: bounded so a huge folder cannot flood the filesystem. */
const statConcurrency = 64;

/**
 * A folder opened for listing, as `path`: lists and stats through it reach
 * that folder even if its path is changed meanwhile.
 */
type OpenFolder =
  | {
      type: "open";
      path: string;
      identity: string;
      /**
       * Whether `identity` can stand for the entries listed now. Timestamps come from a coarse
       * clock (kernel ticks of a few milliseconds, whole seconds on some network storage), so
       * an entry added in the same tick as the folder was opened leaves its change time as it
       * was. Only a change time older than the opening by more than that is trusted, as git
       * treats "racy" index entries; a newer one makes the folder listed in full next time.
       */
      trusted: boolean;
      close: () => void;
    }
  /** Gone, no longer a folder, a symlink, or below one. */
  | { type: "gone" }
  /** Unreadable for another reason (permissions, I/O): keep what was seen. */
  | { type: "unreadable"; code: string | null };

/** A folder a crawl or pass could not read, relative to the root, and the error code why. */
export type UnreadableFolder = { path: string; code: string | null };

/** Unreadable folders named per crawl or pass; the count goes on past this. */
const maxNamedUnreadable = 1000;

const errorCode = (error: unknown) =>
  error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : null;

function noteUnreadable(
  folders: UnreadableFolder[],
  relative: string,
  code: string | null,
) {
  if (folders.length < maxNamedUnreadable)
    folders.push({ path: relative, code });
}

/** Change times this close to the moment a folder is opened are not trusted; see `trusted`. */
const timestampSlackMs = 2000;

/** The clock and folder stat the crawler uses; tests replace them to reproduce filesystems. */
type CrawlerEnvironment = {
  now: () => number;
  statFolder: (
    fd: number,
  ) => Pick<Stats, "dev" | "ino" | "birthtimeMs" | "ctimeMs" | "nlink">;
};
let environment: CrawlerEnvironment = { now: Date.now, statFolder: fstatSync };

/** Use `replacement` until the returned function restores the real clock and stat. */
export function useCrawlerEnvironmentForTest(replacement: CrawlerEnvironment) {
  const previous = environment;
  environment = replacement;
  return () => {
    environment = previous;
  };
}

/**
 * Open the folder at `relative` inside `root`, only while it is a real folder
 * there: a host process may have swapped it, or a folder above it, for a
 * symlink since it was queued. The last part is opened without following a
 * symlink; where the open folder really is then catches a symlink above it.
 */
function openFolder(root: string, relative: string): OpenFolder {
  const absolute = path.join(root, relative);
  let fd;
  try {
    fd = openSync(
      absolute,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
  } catch (error) {
    return isFsError(error, "ENOENT") ||
      isFsError(error, "ENOTDIR") ||
      isFsError(error, "ELOOP")
      ? { type: "gone" }
      : { type: "unreadable", code: errorCode(error) };
  }
  const opened = fd;
  const openedAt = environment.now();
  const close = () => closeSync(opened);
  try {
    // Without descriptor paths, as on macOS, the folder is listed by its path,
    // checked just before.
    const stats = environment.statFolder(opened);
    const listing = DescriptorPath.available
      ? DescriptorPath.of(opened)
      : absolute;
    const there = DescriptorPath.available
      ? DescriptorPath.opened(opened, stats, root, relative)
      : realpathSync(absolute) === path.join(realpathSync(root), relative);
    if (there)
      return {
        type: "open",
        path: listing,
        identity: identityOf(stats),
        trusted: stats.ctimeMs < openedAt - timestampSlackMs,
        close,
      };
    close();
    return { type: "gone" };
  } catch (error) {
    close();
    return isFsError(error, "ENOENT")
      ? { type: "gone" }
      : { type: "unreadable", code: errorCode(error) };
  }
}

/**
 * Which folder on disk a stat describes, as it was then: its inode, with its
 * device and birth time so a number reused for another folder reads
 * differently, and its change time, which moves on whenever an entry is
 * added, removed or renamed in it (and which, unlike its modification time,
 * no process can set back). Taken before the folder is listed, so a change
 * during the listing reads as a change later.
 */
const identityOf = (
  stats: Pick<Stats, "dev" | "ino" | "birthtimeMs" | "ctimeMs">,
) => `${stats.dev}:${stats.ino}:${stats.birthtimeMs}:${stats.ctimeMs}`;

/** Join "/"-separated index paths. */
const childPath = (parent: string, name: string) =>
  parent ? `${parent}/${name}` : name;

/**
 * Same visibility rules as browsing: no `.nimbus`, names with control
 * characters or backslashes, symlinks or special files. Files are stated with
 * lstat for their size, which also confirms they are still regular files.
 */
async function crawlInto(
  index: SearchIndex,
  root: string,
  relative: string,
  parentId: number,
  shouldStop: () => boolean,
  unreadable: UnreadableFolder[],
) {
  const pending: [string, number][] = [[relative, parentId]];
  let listed = 0;
  while (pending.length && !shouldStop()) {
    const next = pending.pop();
    if (next === undefined) break;
    const [directory, id] = next;
    // Removed or unreadable while crawling; reconciliation retries later.
    const folder = openFolder(root, directory);
    if (folder.type === "unreadable")
      noteUnreadable(unreadable, directory, folder.code);
    if (folder.type !== "open") continue;
    try {
      let entries: Dirent[];
      try {
        entries = await readdir(folder.path, { withFileTypes: true });
      } catch (error) {
        if (!isFsError(error, "ENOENT") && !isFsError(error, "ENOTDIR"))
          noteUnreadable(unreadable, directory, errorCode(error));
        continue;
      }
      const files: string[] = [];
      for (const entry of entries) {
        if (unservableName(entry.name)) continue;
        if (entry.isDirectory()) {
          const child = index.addChild(id, entry.name, "dir");
          if (child >= 0)
            pending.push([childPath(directory, entry.name), child]);
        } else if (entry.isFile()) files.push(entry.name);
      }
      // Added in listing order, not as stats finish, so equal matches rank the
      // same way after every crawl and a later page continues where one ended.
      const { sizes } = await statFiles(folder.path, files);
      for (const name of files) {
        const size = sizes.get(name);
        if (size !== undefined) index.addChild(id, name, "file", size);
      }
      // Listed in full: a reconcile can trust its entries until it changes.
      if (sizes.size === files.length && folder.trusted)
        index.setIdentity(id, folder.identity);
      listed += entries.length;
    } finally {
      folder.close();
    }
    if (listed >= 50_000) {
      listed = 0;
      index.maybeCompact();
    }
  }
}

/** Runs one unit of index work so nothing else mutates the index meanwhile. */
export type Serialize = <T>(work: () => Promise<T>) => Promise<T>;

export type ReconcileReport = {
  folders: number;
  /** Folders listed in full; the others were unchanged, so only their files were stated. */
  listed: number;
  /** Folders that could not be read, so their previous contents were kept. */
  unreadable: number;
  /** Which folders could not be listed at all, up to a thousand. */
  unreadableFolders: UnreadableFolder[];
  /** The longest time one folder held the index, a bound on the pause it caused. */
  longestSliceMs: number;
};

/**
 * Bring a live index in line with the disk in place, folder by folder, as a
 * fresh crawl would build it: entries that appeared are added, ones that
 * vanished or became symlinks or special files are removed, files that changed
 * size update their folders' totals, and a file replaced by a folder (or the
 * reverse) changes kind. Unchanged entries are never removed, so searches keep
 * finding them throughout.
 *
 * A folder whose identity is the one recorded when it was last listed in
 * full holds the same entries, so it is not listed again: only its files are
 * stated, for their sizes.
 *
 * Each folder is one slice: listed, stated and applied inside `serialize`, so a
 * watcher change can never land between reading a folder and pruning it, and
 * a change queued meanwhile re-checks its path afterwards. A folder that cannot
 * be read for a reason other than having vanished keeps its previous contents.
 */
export const reconcile = (
  index: SearchIndex,
  root: string,
  serialize: Serialize,
): Promise<ReconcileReport> => {
  const turn = passes++ % fullListingEvery;
  return reconcileFrom(
    index,
    root,
    "",
    0,
    serialize,
    false,
    (id) => id % fullListingEvery === turn,
  );
};

/**
 * Each pass lists one in this many unchanged folders in full anyway, taking turns by index id,
 * so every folder is listed again within this many passes. A recorded identity can mislead:
 * storage whose clock runs behind Nimbus's makes a fresh change look settled, and an entry
 * added in the same coarse timestamp tick leaves the change time as recorded. This bounds how
 * long such an entry can stay missing, for about 6% more listing per pass.
 */
export const fullListingEvery = 16;
let passes = 0;

/**
 * `reconcile`, from the folder `relative` (index id `id`) down. With
 * `changedOnly`, a folder whose identity is the one recorded when it was
 * last listed is not listed again, though the folders in it are still
 * checked: it holds the same entries, while theirs may have changed.
 */
async function reconcileFrom(
  index: SearchIndex,
  root: string,
  relative: string,
  id: number,
  serialize: Serialize,
  changedOnly: boolean,
  /** Unchanged folders to list in full anyway. */
  listAnyway: (id: number) => boolean = () => false,
): Promise<ReconcileReport> {
  const report: ReconcileReport = {
    folders: 0,
    listed: 0,
    unreadable: 0,
    unreadableFolders: [],
    longestSliceMs: 0,
  };
  const pending: [string, number][] = [[relative, id]];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const [directory, folderId] = next;
    const subfolders = await serialize(async () => {
      // Removed by a watcher change since it was queued.
      if (!index.isFolder(folderId)) return [];
      const folder = openFolder(root, directory);
      if (folder.type === "gone") forget(index, folderId);
      if (folder.type === "unreadable") {
        report.unreadable++;
        noteUnreadable(report.unreadableFolders, directory, folder.code);
      }
      if (folder.type !== "open") return [];
      try {
        const unchanged =
          index.identityOf(folderId) === folder.identity &&
          !listAnyway(folderId);
        if (unchanged && changedOnly)
          return index
            .foldersIn(folderId)
            .map((child): [string, number] => [
              childPath(directory, child.name),
              child.id,
            ]);
        if (unchanged)
          return await restateFolder(
            index,
            report,
            folder,
            directory,
            folderId,
          );
        return await reconcileFolder(
          index,
          report,
          folder,
          directory,
          folderId,
        );
      } finally {
        folder.close();
      }
    });
    for (const subfolder of subfolders) pending.push(subfolder);
  }
  return report;
}

/**
 * Drop a folder that is gone, with everything beneath it. The root stays,
 * empty: the data root itself is gone, so nothing in it can be served.
 */
function forget(index: SearchIndex, id: number) {
  if (id !== 0) index.removeId(id);
  else for (const child of index.childrenOf(0)) index.removeId(child.id);
}

/**
 * One reconcile slice for a folder whose identity is the one recorded when
 * it was last listed in full: it holds the same entries, so only its files'
 * sizes are read again, by the ids the index already has. A file gone or no
 * longer regular even so (changed during the pass) is removed; the folder is
 * listed in full next time.
 */
async function restateFolder(
  index: SearchIndex,
  report: ReconcileReport,
  folder: { path: string },
  directory: string,
  id: number,
): Promise<[string, number][]> {
  const files = index.filesIn(id);
  const { sizes, unstated } = await statFiles(
    folder.path,
    files.map((file) => file.name),
  );
  const started = performance.now();
  for (const file of files) {
    const size = sizes.get(file.name);
    if (size !== undefined) index.setFileSize(file.id, size);
    else if (!unstated.has(file.name)) index.removeId(file.id);
  }
  if (unstated.size || sizes.size !== files.length) {
    if (unstated.size) report.unreadable++;
    index.setIdentity(id, "");
  }
  index.maybeCompact();
  report.folders++;
  report.longestSliceMs = Math.max(
    report.longestSliceMs,
    performance.now() - started,
  );
  return index
    .foldersIn(id)
    .map((child): [string, number] => [
      childPath(directory, child.name),
      child.id,
    ]);
}

/** One reconcile slice: compare an open folder with what the index holds for it. */
async function reconcileFolder(
  index: SearchIndex,
  report: ReconcileReport,
  folder: { path: string; identity: string; trusted: boolean },
  directory: string,
  id: number,
): Promise<[string, number][]> {
  const listing = folder.path;
  let entries: Dirent[];
  try {
    entries = await readdir(listing, { withFileTypes: true });
  } catch (error) {
    if (isFsError(error, "ENOENT") || isFsError(error, "ENOTDIR"))
      forget(index, id);
    else {
      report.unreadable++;
      noteUnreadable(report.unreadableFolders, directory, errorCode(error));
    }
    return [];
  }
  const { sizes, unstated } = await statFiles(
    listing,
    entries
      .filter((entry) => entry.isFile() && !unservableName(entry.name))
      .map((entry) => entry.name),
  );
  const started = performance.now();
  const seen = new Set<string>();
  const found: [string, number][] = [];
  for (const entry of entries) {
    if (unservableName(entry.name)) continue;
    if (entry.isDirectory()) {
      const child = index.addChild(id, entry.name, "dir");
      if (child < 0) continue;
      seen.add(entry.name);
      found.push([childPath(directory, entry.name), child]);
    } else if (entry.isFile()) {
      const size = sizes.get(entry.name);
      if (size === undefined) {
        // Not stated, but not gone either: keep what was last seen.
        if (unstated.has(entry.name)) seen.add(entry.name);
        continue;
      }
      index.addChild(id, entry.name, "file", size);
      seen.add(entry.name);
    }
  }
  if (unstated.size) report.unreadable++;
  // Listed in full: a later folder event can trust this until it changes, unless it changed
  // too recently for its change time to tell.
  else if (folder.trusted) index.setIdentity(id, folder.identity);
  for (const child of index.childrenOf(id))
    if (!seen.has(child.name)) index.removeId(child.id);
  index.maybeCompact();
  report.folders++;
  report.listed++;
  report.longestSliceMs = Math.max(
    report.longestSliceMs,
    performance.now() - started,
  );
  return found;
}

/**
 * Sizes of the regular files among `names`, stated with bounded concurrency.
 * Names that are gone or no longer files are in neither result; names that
 * could not be stated for another reason (permissions, I/O) are `unstated`.
 */
async function statFiles(directory: string, names: readonly string[]) {
  const sizes = new Map<string, number>();
  const unstated = new Set<string>();
  let cursor = 0;
  const statNext = async () => {
    for (let at = cursor++; at < names.length; at = cursor++) {
      const name = names[at];
      if (name === undefined) continue;
      try {
        const stats = await lstat(path.join(directory, name));
        if (stats.isFile()) sizes.set(name, stats.size);
      } catch (error) {
        // Removed since the folder was listed, or not stated for another reason.
        if (!isFsError(error, "ENOENT") && !isFsError(error, "ENOTDIR"))
          unstated.add(name);
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(statConcurrency, names.length) }, statNext),
  );
  return { sizes, unstated };
}

/** Relative "/"-separated path inside `root`, or null when outside, private or unservable. */
export function indexedPath(root: string, absolute: string) {
  const relative = path.relative(root, absolute);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  )
    return null;
  const segments = relative.split(path.sep);
  return segments.some(unservableName) ? null : segments.join("/");
}

/** Fill `index` from the disk; folders that could not be read are named in the result. */
export async function crawl(
  index: SearchIndex,
  root: string,
  shouldStop: () => boolean = () => false,
) {
  const unreadableFolders: UnreadableFolder[] = [];
  await crawlInto(index, root, "", 0, shouldStop, unreadableFolders);
  index.compact();
  return { unreadableFolders };
}

/**
 * Bring one path in line with the disk after a watcher event. A folder that
 * appears (moved or copied in) is crawled, because the watcher reports only
 * the folder itself. A folder already indexed is compared with the disk
 * too, as it may be another folder now, or the same one changed while its
 * events were lost (moved out and back); folders whose identity shows no
 * change since they were last listed are not listed again.
 */
export async function applyChange(
  index: SearchIndex,
  root: string,
  absolute: string,
) {
  const relative = indexedPath(root, absolute);
  if (relative === null) return;
  // The path is stated through its folder, so a symlink above it is never followed.
  const slash = relative.lastIndexOf("/");
  const parent = openFolder(root, relative.slice(0, Math.max(0, slash)));
  if (parent.type === "unreadable") return;
  if (parent.type === "gone") {
    index.remove(relative);
    return;
  }
  let stats;
  try {
    stats = await lstat(path.join(parent.path, relative.slice(slash + 1)));
  } catch (error) {
    // Kept as last seen when it exists but cannot be stated.
    if (isFsError(error, "ENOENT") || isFsError(error, "ENOTDIR"))
      index.remove(relative);
    return;
  } finally {
    parent.close();
  }
  if (stats.isDirectory()) {
    // New, replaced, only known from changes inside it, or changed while
    // events were lost: its folders are compared with the disk, and each
    // one listed again unless it is unchanged since it was last listed.
    const id = index.add(relative, "dir");
    if (id >= 0)
      await reconcileFrom(index, root, relative, id, (work) => work(), true);
  } else if (stats.isFile()) index.add(relative, "file", stats.size);
  else index.remove(relative);
  index.maybeCompact();
}
