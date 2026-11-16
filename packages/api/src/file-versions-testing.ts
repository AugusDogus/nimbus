import type { FileVersion, FileVersionStore } from "./file-versions";
import { isWithinPath } from "./safe-path";

/** In-memory FileVersionStore with the same ordering as SQLite. */
export function createTestFileVersionStore() {
  const versions = new Map<string, FileVersion>();
  const take = (predicate: (version: FileVersion) => boolean) => {
    const removed = [...versions.values()].filter(predicate);
    for (const version of removed) versions.delete(version.id);
    return removed;
  };
  const store: FileVersionStore = {
    async add(version) {
      versions.set(version.id, { ...version });
    },
    async list(path) {
      return [...versions.values()]
        .filter((version) => version.path === path)
        .sort((a, b) => b.archivedAt - a.archivedAt || (a.id < b.id ? 1 : -1));
    },
    async get(id) {
      return versions.get(id) ?? null;
    },
    async remove(ids) {
      return take((version) => ids.includes(version.id));
    },
    async removeAt(path) {
      return take((version) => isWithinPath(path, version.path));
    },
    async archivedBefore(cutoff) {
      return [...versions.values()].filter(
        (version) => version.archivedAt < cutoff,
      );
    },
    async existing(ids) {
      return new Set(ids.filter((id) => versions.has(id)));
    },
  };
  return {
    ...store,
    /** What the drive store does inside its rename, trash and restore transactions. */
    relocate(from: string, to: string) {
      take((version) => isWithinPath(to, version.path));
      for (const version of versions.values())
        if (isWithinPath(from, version.path))
          version.path = to + version.path.slice(from.length);
    },
  };
}
