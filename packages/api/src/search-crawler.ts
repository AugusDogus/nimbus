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
