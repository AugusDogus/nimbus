import { desc, eq, inArray, lt } from "drizzle-orm";
import type { FileVersionStore } from "@nimbus/api/file-versions";
import type { db } from "./db";
import { fileVersions } from "./db/schema";

export function createFileVersionStore(database: typeof db): FileVersionStore {
  const removeWhere = async (condition: ReturnType<typeof eq>) =>
    database.delete(fileVersions).where(condition).returning();
  return {
    async add(version) {
      await database.insert(fileVersions).values(version);
    },
    async rekey(from, to) {
      await database
        .update(fileVersions)
        .set({ fileKey: to })
        .where(eq(fileVersions.fileKey, from));
    },
    async list(fileKey) {
      return database
        .select()
        .from(fileVersions)
        .where(eq(fileVersions.fileKey, fileKey))
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
    async removeFileKeys(keys) {
      return keys.length ? removeWhere(inArray(fileVersions.fileKey, [...keys])) : [];
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
