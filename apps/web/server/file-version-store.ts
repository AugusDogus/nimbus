import { desc, eq, inArray, lt, type SQL } from "drizzle-orm";
import type { FileVersionStore } from "@nimbus/api/file-versions";
import type { Database } from "./db";
import { atOrUnder } from "./db/path-prefix";
import { fileVersions } from "./db/schema";

export function createFileVersionStore(database: Database): FileVersionStore {
  const removeWhere = async (condition: SQL) =>
    database.delete(fileVersions).where(condition).returning();
  return {
    async add(version) {
      await database.insert(fileVersions).values(version);
    },
    async list(path) {
      return database
        .select()
        .from(fileVersions)
        .where(eq(fileVersions.path, path))
        .orderBy(desc(fileVersions.archivedAt), desc(fileVersions.id));
    },
    async get(id) {
      const [row] = await database
        .select()
        .from(fileVersions)
        .where(eq(fileVersions.id, id));
      return row ?? null;
    },
    async remove(ids) {
      return ids.length ? removeWhere(inArray(fileVersions.id, [...ids])) : [];
    },
    async removeAt(path) {
      return removeWhere(atOrUnder(fileVersions.path, path));
    },
    async archivedBefore(cutoff) {
      return database
        .select()
        .from(fileVersions)
        .where(lt(fileVersions.archivedAt, cutoff));
    },
    async existing(ids) {
      if (!ids.length) return new Set();
      const rows = await database
        .select({ id: fileVersions.id })
        .from(fileVersions)
        .where(inArray(fileVersions.id, [...ids]));
      return new Set(rows.map((row) => row.id));
    },
  };
}
