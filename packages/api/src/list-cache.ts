import path from "node:path";

import { getDataRoot } from "./data-root";

export type CachedListEntry = {
  name: string;
  path: string;
  type: "dir" | "file" | "other";
  mtime: number | null;
  size: number | null;
};

type ListCacheEntry = {
  entries: CachedListEntry[];
  updatedAt: number;
};

type ListCacheState = {
  entries: Map<string, ListCacheEntry>;
};

const parsePositiveInt = (value: string | undefined, fallback: number) => {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const LIST_CACHE_TTL_MS = parsePositiveInt(
  process.env.NIMBUS_LIST_CACHE_TTL_MS,
  2_000,
);
const LIST_CACHE_MAX_ENTRIES = parsePositiveInt(
  process.env.NIMBUS_LIST_CACHE_MAX,
  5_000,
);

const globalForListCache = globalThis as typeof globalThis & {
  __nimbusListCache?: ListCacheState;
};

const listCache: ListCacheState = globalForListCache.__nimbusListCache ?? {
  entries: new Map<string, ListCacheEntry>(),
};

if (!globalForListCache.__nimbusListCache) {
  globalForListCache.__nimbusListCache = listCache;
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

const getParentDir = (relativePath: string) => {
  const normalized = normalizeRelativePath(relativePath);
  return normalized.includes("/")
    ? normalized.slice(0, normalized.lastIndexOf("/"))
    : "";
};

const evictOldest = () => {
  while (listCache.entries.size > LIST_CACHE_MAX_ENTRIES) {
    const oldestKey = listCache.entries.keys().next().value;
    if (!oldestKey) {
      break;
    }
    listCache.entries.delete(oldestKey);
  }
};

const buildKey = (options: {
  relativePath: string;
  includeStats: boolean;
  dirMtimeMs: number | null;
  permsHash: string;
}) => {
  const { relativePath, includeStats, dirMtimeMs, permsHash } = options;
  return [
    permsHash,
    includeStats ? "1" : "0",
    dirMtimeMs ?? "null",
    normalizeRelativePath(relativePath),
  ].join("|");
};

export const getListCacheKey = buildKey;

export const getListCache = (key: string) => {
  const entry = listCache.entries.get(key);
  if (!entry) {
    return null;
  }
  if (Date.now() - entry.updatedAt > LIST_CACHE_TTL_MS) {
    listCache.entries.delete(key);
    return null;
  }
  listCache.entries.delete(key);
  listCache.entries.set(key, entry);
  return entry.entries;
};

export const setListCache = (key: string, entries: CachedListEntry[]) => {
  listCache.entries.set(key, { entries, updatedAt: Date.now() });
  evictOldest();
};

export const invalidateListCache = (eventPath: string) => {
  const relative = resolveEventRelativePath(eventPath);
  if (relative === null) {
    return;
  }
  const parent = getParentDir(relative);
  const targets = new Set<string>([normalizeRelativePath(relative), parent]);
  for (const key of listCache.entries.keys()) {
    const keyParts = key.split("|");
    const keyPath = keyParts.at(-1);
    if (keyPath !== undefined && targets.has(keyPath)) {
      listCache.entries.delete(key);
    }
  }
};

export const resetListCacheForTest = () => {
  listCache.entries.clear();
};
