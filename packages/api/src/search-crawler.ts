import type { Dirent } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import type { SearchIndex } from "./search-index";

const isPrivate = (name: string) => name.toLowerCase() === ".nimbus";

/** Files stated at once per folder: bounded so a huge folder cannot flood the filesystem. */
const statConcurrency = 64;

/**
 * Same visibility rules as browsing: no `.nimbus`, symlinks or special files.
 * Files are stated with lstat for their size, which also confirms they are
 * still regular files.
 */
async function crawlInto(
  index: SearchIndex,
  absolute: string,
  parentId: number,
  shouldStop: () => boolean,
) {
  const pending: [string, number][] = [[absolute, parentId]];
  let listed = 0;
  while (pending.length && !shouldStop()) {
    const next = pending.pop();
    if (next === undefined) break;
    const [directory, id] = next;
    let entries: Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      // Removed or unreadable while crawling; reconciliation retries later.
      continue;
    }
    const files: string[] = [];
    for (const entry of entries) {
      if (isPrivate(entry.name)) continue;
      if (entry.isDirectory()) {
        const child = index.addChild(id, entry.name, "dir");
        if (child >= 0) pending.push([path.join(directory, entry.name), child]);
      } else if (entry.isFile()) files.push(entry.name);
    }
    let cursor = 0;
    const statNext = async () => {
      for (let at = cursor++; at < files.length; at = cursor++) {
        const name = files[at];
        if (name === undefined) continue;
        try {
          const stats = await lstat(path.join(directory, name));
          if (stats.isFile()) index.addChild(id, name, "file", stats.size);
        } catch {
          // Removed while crawling.
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(statConcurrency, files.length) }, statNext),
    );
    listed += entries.length;
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
  const pending: [string, number][] = [[root, 0]];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const [directory, id] = next;
    const subfolders = await serialize(async () => {
      // Removed by a watcher change since it was queued.
      if (!index.isFolder(id)) return [];
      let entries: Dirent[];
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch (error) {
        const vanished =
          error instanceof Error &&
          "code" in error &&
          (error.code === "ENOENT" || error.code === "ENOTDIR");
        if (vanished) index.removeId(id);
        else report.unreadable++;
        return [];
      }
      const stats = await statFiles(
        directory,
        entries
          .filter((entry) => entry.isFile() && !isPrivate(entry.name))
          .map((entry) => entry.name),
      );
      const started = performance.now();
      const seen = new Set<string>();
      const found: [string, number][] = [];
      for (const entry of entries) {
        if (isPrivate(entry.name)) continue;
        if (entry.isDirectory()) {
          const child = index.addChild(id, entry.name, "dir");
          if (child < 0) continue;
          seen.add(entry.name);
          found.push([path.join(directory, entry.name), child]);
        } else if (entry.isFile()) {
          const size = stats.get(entry.name);
          if (size === undefined) continue;
          index.addChild(id, entry.name, "file", size);
          seen.add(entry.name);
        }
      }
      for (const child of index.childrenOf(id))
        if (!seen.has(child.name)) index.removeId(child.id);
      index.maybeCompact();
      report.folders++;
      report.longestSliceMs = Math.max(
        report.longestSliceMs,
        performance.now() - started,
      );
      return found;
    });
    for (const subfolder of subfolders) pending.push(subfolder);
  }
  return report;
}

/** Sizes of the regular files among `names`, stated with bounded concurrency. Others are absent. */
async function statFiles(directory: string, names: readonly string[]) {
  const sizes = new Map<string, number>();
  let cursor = 0;
  const statNext = async () => {
    for (let at = cursor++; at < names.length; at = cursor++) {
      const name = names[at];
      if (name === undefined) continue;
      try {
        const stats = await lstat(path.join(directory, name));
        if (stats.isFile()) sizes.set(name, stats.size);
      } catch {
        // Removed since the folder was listed.
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(statConcurrency, names.length) }, statNext),
  );
  return sizes;
}

/** Relative "/"-separated path inside `root`, or null when outside or private. */
export function indexedPath(root: string, absolute: string) {
  const relative = path.relative(root, absolute);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
    return null;
  const segments = relative.split(path.sep);
  return segments.some(isPrivate) ? null : segments.join("/");
}

export async function crawl(
  index: SearchIndex,
  root: string,
  shouldStop: () => boolean = () => false,
) {
  await crawlInto(index, root, 0, shouldStop);
  index.compact();
}

/**
 * Bring one path in line with the disk after a watcher event. A folder that
 * appears (moved or copied in) is crawled, because the watcher reports only
 * the folder itself.
 */
export async function applyChange(
  index: SearchIndex,
  root: string,
  absolute: string,
) {
  const relative = indexedPath(root, absolute);
  if (relative === null) return;
  let stats;
  try {
    stats = await lstat(absolute);
  } catch {
    index.remove(relative);
    return;
  }
  if (stats.isDirectory()) {
    const known = index.kindOf(relative) === "dir";
    const id = index.add(relative, "dir");
    if (!known && id >= 0) await crawlInto(index, absolute, id, () => false);
  } else if (stats.isFile()) index.add(relative, "file", stats.size);
  else index.remove(relative);
  index.maybeCompact();
}
