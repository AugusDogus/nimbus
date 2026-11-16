import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";

import { getDataRoot } from "./data-root";
import { statPath } from "./fs-utils";
import { isFsError } from "./safe-path";

type StorageCacheState = {
  usedBytes: number | null;
  fileSizes: Map<string, number>;
  lastComputedAt: number;
  lastFullScanAt: number;
  pendingTimeout: ReturnType<typeof setTimeout> | null;
  inFlight: Promise<number> | null;
  dirty: boolean;
};

const CACHE_TTL_MS = 5 * 60_000;
const FULL_RESCAN_INTERVAL_MS = 20 * 60_000;
const EVENT_DEBOUNCE_MS = 2_000;

const globalForStorage = globalThis as typeof globalThis & {
  __nimbusStorageCache?: StorageCacheState;
};

const storageCache: StorageCacheState = globalForStorage.__nimbusStorageCache ?? {
  usedBytes: null,
  fileSizes: new Map<string, number>(),
  lastComputedAt: 0,
  lastFullScanAt: 0,
  pendingTimeout: null,
  inFlight: null,
  dirty: false,
};

if (!globalForStorage.__nimbusStorageCache) {
  globalForStorage.__nimbusStorageCache = storageCache;
}

const shouldIgnorePath = (value: string) => {
  const normalized = value.split(path.sep).join("/");
  return normalized.split("/").includes(".nimbus");
};

const getDirectorySize = async (
  directory: string,
  fileSizes: Map<string, number>,
): Promise<number> => {
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return 0;
  }

  const sizes = await Promise.all(
    entries.map(async (entry) => {
      if (entry.name === ".nimbus" || entry.isSymbolicLink()) {
        return 0;
      }

      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        return getDirectorySize(fullPath, fileSizes);
      }

      if (!entry.isFile()) {
        return 0;
      }

      try {
        const stats = await statPath(fullPath);
        fileSizes.set(fullPath, stats.size);
        return stats.size;
      } catch {
        return 0;
      }
    }),
  );

  return sizes.reduce((total, size) => total + size, 0);
};

const resolveEventPath = (eventPath: string) => {
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

  return absolute;
};

const applyDelta = async (event: { path: string; event: string }) => {
  if (storageCache.inFlight) {
    storageCache.dirty = true;
    scheduleRecompute();
    return;
  }

  if (storageCache.usedBytes === null) {
    storageCache.dirty = true;
    scheduleRecompute();
    return;
  }

  const absolute = resolveEventPath(event.path);
  if (!absolute) {
    return;
  }

  if (event.event === "delete") {
    const previous = storageCache.fileSizes.get(absolute);
    if (previous === undefined) {
      storageCache.dirty = true;
      scheduleRecompute();
      return;
    }
    storageCache.usedBytes = Math.max(
      0,
      storageCache.usedBytes - previous,
    );
    storageCache.fileSizes.delete(absolute);
    return;
  }

  try {
    const stats = await statPath(absolute);
    if (stats.isDirectory || !stats.isFile) {
      storageCache.dirty = true;
      scheduleRecompute();
      return;
    }

    const nextSize = stats.size;
    const previousSize = storageCache.fileSizes.get(absolute) ?? 0;
    storageCache.fileSizes.set(absolute, nextSize);
    storageCache.usedBytes = Math.max(
      0,
      storageCache.usedBytes - previousSize + nextSize,
    );
  } catch (error) {
    if (isFsError(error, "ENOENT")) {
      const previous = storageCache.fileSizes.get(absolute);
      if (previous !== undefined) {
        storageCache.usedBytes = Math.max(
          0,
          storageCache.usedBytes - previous,
        );
        storageCache.fileSizes.delete(absolute);
        return;
      }
    }
    storageCache.dirty = true;
    scheduleRecompute();
  }
};

const computeStorageUsage = async () => {
  if (storageCache.inFlight) {
    return storageCache.inFlight;
  }

  storageCache.inFlight = (async () => {
    const root = getDataRoot();
    const fileSizes = new Map<string, number>();
    const usedBytes = await getDirectorySize(root, fileSizes);
    storageCache.usedBytes = usedBytes;
    storageCache.fileSizes = fileSizes;
    storageCache.lastComputedAt = Date.now();
    storageCache.lastFullScanAt = storageCache.lastComputedAt;
    storageCache.dirty = false;
    storageCache.inFlight = null;
    return usedBytes;
  })();

  return storageCache.inFlight;
};

const scheduleRecompute = () => {
  if (storageCache.pendingTimeout) {
    return;
  }
  storageCache.pendingTimeout = setTimeout(() => {
    storageCache.pendingTimeout = null;
    void computeStorageUsage();
  }, EVENT_DEBOUNCE_MS);
};

export const resetStorageCacheForTest = () => {
  if (storageCache.pendingTimeout) {
    clearTimeout(storageCache.pendingTimeout);
  }
  storageCache.usedBytes = null;
  storageCache.fileSizes = new Map<string, number>();
  storageCache.lastComputedAt = 0;
  storageCache.lastFullScanAt = 0;
  storageCache.pendingTimeout = null;
  storageCache.inFlight = null;
  storageCache.dirty = false;
};

export const noteFileEvent = (event: {
  path: string;
  event: string;
  ts: number;
}) => {
  if (shouldIgnorePath(event.path)) {
    return;
  }
  void applyDelta(event);
};

export const getStorageUsage = async () => {
  const now = Date.now();
  if (storageCache.usedBytes === null) {
    return computeStorageUsage();
  }

  if (storageCache.dirty) {
    scheduleRecompute();
    return storageCache.usedBytes;
  }

  if (now - storageCache.lastFullScanAt > FULL_RESCAN_INTERVAL_MS) {
    void computeStorageUsage();
    return storageCache.usedBytes;
  }

  if (now - storageCache.lastComputedAt > CACHE_TTL_MS) {
    void computeStorageUsage();
  }

  return storageCache.usedBytes;
};
