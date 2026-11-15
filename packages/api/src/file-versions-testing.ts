import type { FileVersion, FileVersionStore } from "./file-versions";

/** In-memory FileVersionStore with the same ordering as SQLite. */
export function createTestFileVersionStore(): FileVersionStore {
  const versions = new Map<string, FileVersion>();
  const take = (predicate: (version: FileVersion) => boolean) => {
    const removed = [...versions.values()].filter(predicate);
    for (const version of removed) versions.delete(version.id);
    return removed;
  };
  return {
    async add(version) { versions.set(version.id, { ...version }); },
    async rekey(from, to) { for (const version of versions.values()) if (version.fileKey === from) version.fileKey = to; },
    async list(fileKey) { return [...versions.values()].filter((version) => version.fileKey === fileKey).sort((a, b) => b.archivedAt - a.archivedAt || (a.id < b.id ? 1 : -1)); },
    async get(id) { return versions.get(id) ?? null; },
    async remove(ids) { return take((version) => ids.includes(version.id)); },
    async removeFileKeys(keys) { return take((version) => keys.includes(version.fileKey)); },
    async archivedBefore(cutoff) { return [...versions.values()].filter((version) => version.archivedAt < cutoff); },
    async existing(ids) { return new Set(ids.filter((id) => versions.has(id))); },
  };
}
