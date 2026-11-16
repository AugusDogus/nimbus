import path from "node:path";

import { getDataRoot } from "./data-root";

export type CachedDirEntry = {
  name: string;
  path: string;
  type: "dir" | "file" | "other";
};

type DirCacheEntry = {
  entries: CachedDirEntry[];
  dirMtimeMs: number | null;
  updatedAt: number;
  dirty: boolean;
};

type DirListCacheState = {
  entries: Map<string, DirCacheEntry>;
};

const parsePositiveInt = (value: string | undefined, fallback: number) => {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const CACHE_TTL_MS = parsePositiveInt(
  process.env.NIMBUS_DIR_CACHE_TTL_MS,
  30_000,
);
const CACHE_MAX_ENTRIES = parsePositiveInt(
  process.env.NIMBUS_DIR_CACHE_MAX,
  10_000,
);

const globalForDirCache = globalThis as typeof globalThis & {
  __nimbusDirListCache?: DirListCacheState;
};

const dirListCache: DirListCacheState = globalForDirCache.__nimbusDirListCache ?? {
  entries: new Map<string, DirCacheEntry>(),
};

if (!globalForDirCache.__nimbusDirListCache) {
  globalForDirCache.__nimbusDirListCache = dirListCache;
}

const normalizeRelativePath = (value: string) => {
  const normalized = value.replace(/\\/g, "/");
  return normalized.startsWith("/") ? normalized.slice(1) : normalized;
};

const shouldIgnorePath = (value: string) => {
  const normalized = normalizeRelativePath(value);
  return normalized.split("/").includes(".nimbus");
};

const resolveEventRelativePath = (eventPath: string) => {
  const root = getDataRoot();
  const absolute = path.isAbsolute(eventPath)
    ? eventPath
    : path.resolve(root, eventPath);
  const relative = path.relative(root, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }
  if (shouldIgnorePath(relative)) {
    return null;
  }
  return normalizeRelativePath(relative);
};

const markDirDirty = (relativePath: string) => {
  const key = normalizeRelativePath(relativePath);
  const entry = dirListCache.entries.get(key);
  if (entry) {
    entry.dirty = true;
  }
};

const deleteDirEntry = (relativePath: string) => {
  const key = normalizeRelativePath(relativePath);
  dirListCache.entries.delete(key);
};

const evictOldest = () => {
  while (dirListCache.entries.size > CACHE_MAX_ENTRIES) {
    const oldestKey = dirListCache.entries.keys().next().value;
    if (!oldestKey) {
      break;
    }
    dirListCache.entries.delete(oldestKey);
  }
};

export const getDirEntries = (
  relativePath: string,
  dirMtimeMs: number | null,
) => {
  const key = normalizeRelativePath(relativePath);
  const entry = dirListCache.entries.get(key);
  if (!entry) {
    return null;
  }
  if (entry.dirty) {
    return null;
  }
  if (entry.dirMtimeMs !== dirMtimeMs) {
    return null;
  }
  if (Date.now() - entry.updatedAt > CACHE_TTL_MS) {
    return null;
  }
  dirListCache.entries.delete(key);
  dirListCache.entries.set(key, entry);
  return entry.entries;
};

export const setDirEntries = (
  relativePath: string,
  entries: CachedDirEntry[],
  dirMtimeMs: number | null,
) => {
  const key = normalizeRelativePath(relativePath);
  dirListCache.entries.set(key, {
    entries,
    dirMtimeMs,
    updatedAt: Date.now(),
    dirty: false,
  });
  evictOldest();
};

export const invalidateDirCache = (eventPath: string) => {
  const relative = resolveEventRelativePath(eventPath);
  if (relative === null) {
    return;
  }

  const normalized = normalizeRelativePath(relative);
  const parent = normalized.includes("/")
    ? normalized.slice(0, normalized.lastIndexOf("/"))
    : "";

  // Invalidate the direct parent and all ancestors up to root.
  const parts = parent ? parent.split("/") : [];
  for (let idx = parts.length; idx >= 0; idx -= 1) {
    const ancestor = idx === 0 ? "" : parts.slice(0, idx).join("/");
    markDirDirty(ancestor);
    deleteDirEntry(ancestor);
  }

  // Also remove any cached entry for the path itself (in case it's a dir).
  deleteDirEntry(normalized);
};

export const getParentDir = (eventPath: string) => {
  const relative = resolveEventRelativePath(eventPath);
  if (relative === null) {
    return null;
  }
  const normalized = normalizeRelativePath(relative);
  const parentDir = normalized.includes("/")
    ? normalized.slice(0, normalized.lastIndexOf("/"))
    : "";
  return parentDir;
};

export const resetDirListCacheForTest = () => {
  dirListCache.entries.clear();
};
