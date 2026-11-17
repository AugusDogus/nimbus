import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  openSync,
  readlinkSync,
  realpathSync,
  type Dirent,
  type Stats,
} from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
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

/** Linux names every open descriptor by a path that reaches the same file. */
const descriptorPaths = existsSync("/proc/self/fd");

/** Each data root's real path, read again whenever a folder seems to have moved. */
const realRoots = new Map<string, string>();

/**
 * A folder opened for listing, as `path`: lists and stats through it reach
 * that folder even if its path is changed meanwhile.
 */
type OpenFolder =
  | { type: "open"; path: string; identity: string; close: () => void }
  /** Gone, no longer a folder, a symlink, or below one. */
  | { type: "gone" }
  /** Unreadable for another reason (permissions, I/O): keep what was seen. */
  | { type: "unreadable" };

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
      : { type: "unreadable" };
  }
  const opened = fd;
  const close = () => closeSync(opened);
  try {
    // Without descriptor paths, as on macOS, the folder is listed by its path,
    // checked just before.
    const listing = descriptorPaths ? `/proc/self/fd/${opened}` : absolute;
    const actual = descriptorPaths
      ? readlinkSync(listing)
      : realpathSync(absolute);
    const expected = (fresh: boolean) => {
      let real = realRoots.get(root);
      if (real === undefined || fresh) {
        real = realpathSync(root);
        realRoots.set(root, real);
      }
      return path.join(real, relative);
    };
    if (actual === expected(false) || actual === expected(true))
      return {
        type: "open",
        path: listing,
        identity: identityOf(fstatSync(opened)),
        close,
      };
    close();
    return { type: "gone" };
  } catch (error) {
    close();
    return isFsError(error, "ENOENT")
      ? { type: "gone" }
      : { type: "unreadable" };
  }
}

/**
 * Which folder on disk a stat describes: its inode, with its device and birth
 * time so a number reused for another folder reads differently.
 */
const identityOf = (stats: Stats) =>
  `${stats.dev}:${stats.ino}:${stats.birthtimeMs}`;

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
) {
  const pending: [string, number][] = [[relative, parentId]];
  let listed = 0;
  while (pending.length && !shouldStop()) {
    const next = pending.pop();
    if (next === undefined) break;
    const [directory, id] = next;
    // Removed or unreadable while crawling; reconciliation retries later.
    const folder = openFolder(root, directory);
    if (folder.type !== "open") continue;
    index.setIdentity(id, folder.identity);
    try {
      let entries: Dirent[];
      try {
        entries = await readdir(folder.path, { withFileTypes: true });
      } catch {
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
  /** Folders that could not be read, so their previous contents were kept. */
  unreadable: number;
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
 * Each folder is one slice: listed, stated and applied inside `serialize`, so a
 * watcher change can never land between reading a folder and pruning it, and
 * a change queued meanwhile re-checks its path afterwards. A folder that cannot
 * be read for a reason other than having vanished keeps its previous contents.
 */
export async function reconcile(
  index: SearchIndex,
  root: string,
  serialize: Serialize,
): Promise<ReconcileReport> {
  const report: ReconcileReport = {
    folders: 0,
    unreadable: 0,
    longestSliceMs: 0,
  };
  const pending: [string, number][] = [["", 0]];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const [directory, id] = next;
    const subfolders = await serialize(async () => {
      // Removed by a watcher change since it was queued.
      if (!index.isFolder(id)) return [];
      const folder = openFolder(root, directory);
      if (folder.type === "gone") forget(index, id);
      if (folder.type === "unreadable") report.unreadable++;
      if (folder.type !== "open") return [];
      index.setIdentity(id, folder.identity);
      try {
        return await reconcileFolder(index, report, folder.path, directory, id);
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

/** One reconcile slice: compare an open folder with what the index holds for it. */
async function reconcileFolder(
  index: SearchIndex,
  report: ReconcileReport,
  listing: string,
  directory: string,
  id: number,
): Promise<[string, number][]> {
  let entries: Dirent[];
  try {
    entries = await readdir(listing, { withFileTypes: true });
  } catch (error) {
    if (isFsError(error, "ENOENT") || isFsError(error, "ENOTDIR"))
      forget(index, id);
    else report.unreadable++;
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
  for (const child of index.childrenOf(id))
    if (!seen.has(child.name)) index.removeId(child.id);
  index.maybeCompact();
  report.folders++;
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

export async function crawl(
  index: SearchIndex,
  root: string,
  shouldStop: () => boolean = () => false,
) {
  await crawlInto(index, root, "", 0, shouldStop);
  index.compact();
}

/**
 * Bring one path in line with the disk after a watcher event. A folder that
 * appears (moved or copied in) is crawled, because the watcher reports only
 * the folder itself; so is one that replaced a folder of the same name, or
 * that was only known from changes inside it, told apart by its identity.
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
    let id = index.add(relative, "dir");
    const known = id >= 0 ? index.identityOf(id) : undefined;
    if (id >= 0 && known !== identityOf(stats)) {
      // Another folder under the same name: what was indexed there is not in it.
      if (known !== undefined) {
        index.removeId(id);
        id = index.add(relative, "dir");
      }
      // New, replaced, or only known as the folder above an earlier change.
      if (id >= 0) await crawlInto(index, root, relative, id, () => false);
    }
  } else if (stats.isFile()) index.add(relative, "file", stats.size);
  else index.remove(relative);
  index.maybeCompact();
}
