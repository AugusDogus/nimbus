import path from "node:path";

export type CachedStats = {
  size: number;
  mtime: number;
  updatedAt: number;
};

type StatsCacheState = {
  entries: Map<string, CachedStats>;
};

const parsePositiveInt = (value: string | undefined, fallback: number) => {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const STATS_CACHE_TTL_MS = parsePositiveInt(
  process.env.NIMBUS_STATS_CACHE_TTL_MS,
  10 * 60 * 1000,
);
const STATS_CACHE_MAX_ENTRIES = parsePositiveInt(
  process.env.NIMBUS_STATS_CACHE_MAX,
  1_000_000,
);

const globalForStats = globalThis as typeof globalThis & {
  __nimbusStatsCache?: StatsCacheState;
};

const statsCache: StatsCacheState = globalForStats.__nimbusStatsCache ?? {
  entries: new Map<string, CachedStats>(),
};

if (!globalForStats.__nimbusStatsCache) {
  globalForStats.__nimbusStatsCache = statsCache;
}

const normalizeRelativePath = (value: string) => {
  const normalized = value.replace(/\\/g, "/");
  return normalized.startsWith("/") ? normalized.slice(1) : normalized;
};

const shouldIgnorePath = (value: string) => {
  const normalized = normalizeRelativePath(value);
  return normalized.split("/").includes(".nimbus");
};

const evictOldest = () => {
  while (statsCache.entries.size > STATS_CACHE_MAX_ENTRIES) {
    const oldestKey = statsCache.entries.keys().next().value as
      | string
      | undefined;
    if (!oldestKey) {
      break;
    }
    statsCache.entries.delete(oldestKey);
  }
};

export const getStats = (relativePath: string) => {
  if (!relativePath) {
    return null;
  }
  const key = normalizeRelativePath(relativePath);
  const entry = statsCache.entries.get(key) ?? null;
  if (!entry) {
    return null;
  }
  if (Date.now() - entry.updatedAt > STATS_CACHE_TTL_MS) {
    statsCache.entries.delete(key);
    return null;
  }
  statsCache.entries.delete(key);
  statsCache.entries.set(key, entry);
  return entry;
};

export const setStats = (
  relativePath: string,
  stats: { size: number; mtime: number },
) => {
  if (!relativePath) {
    return;
  }
  if (path.isAbsolute(relativePath)) {
    return;
  }
  if (shouldIgnorePath(relativePath)) {
    return;
  }
  const key = normalizeRelativePath(relativePath);
  statsCache.entries.set(key, {
    size: stats.size,
    mtime: stats.mtime,
    updatedAt: Date.now(),
  });
  evictOldest();
};

export const deleteStats = (relativePath: string) => {
  if (!relativePath) {
    return;
  }
  if (path.isAbsolute(relativePath)) {
    return;
  }
  const key = normalizeRelativePath(relativePath);
  statsCache.entries.delete(key);
};

export const getForDir = (dirRelativePath: string) => {
  const normalizedDir = normalizeRelativePath(dirRelativePath);
  const dirKey = normalizedDir.endsWith("/")
    ? normalizedDir.slice(0, -1)
    : normalizedDir;
  const result = new Map<string, CachedStats>();
  const now = Date.now();
  const toDelete: string[] = [];
  const toRefresh: string[] = [];

  for (const [relativePath, stats] of statsCache.entries) {
    if (now - stats.updatedAt > STATS_CACHE_TTL_MS) {
      toDelete.push(relativePath);
      continue;
    }
    const normalized = normalizeRelativePath(relativePath);
    const parent = normalized.includes("/")
      ? normalized.slice(0, normalized.lastIndexOf("/"))
      : "";
    if (parent !== dirKey) {
      continue;
    }
    const name = normalized.slice(parent ? parent.length + 1 : 0);
    if (name) {
      result.set(name, stats);
      toRefresh.push(relativePath);
    }
  }

  for (const key of toDelete) {
    statsCache.entries.delete(key);
  }
  for (const key of toRefresh) {
    const entry = statsCache.entries.get(key);
    if (!entry) {
      continue;
    }
    statsCache.entries.delete(key);
    statsCache.entries.set(key, entry);
  }

  return result;
};

export const resetStatsCacheForTest = () => {
  statsCache.entries.clear();
};
