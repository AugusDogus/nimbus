import { and, eq, inArray, or, sql } from "drizzle-orm";
import type { DriveStore, Grant } from "@nimbus/api/drive-store";
import { isWithinPath } from "@nimbus/api/safe-path";
import type { db } from "./db";
import {
  appPasswords,
  bookmarks,
  grants,
  groupMembers,
  groups,
  shares,
  trash,
  user,
} from "./db/schema";

const toGrant = (row: typeof grants.$inferSelect): Grant => ({
  id: row.id,
  path: row.path,
  permission: row.permission,
  subject:
    row.subjectType === "user"
      ? { type: "user", id: row.subjectId }
      : { type: "group", id: row.subjectId },
});

export function createDriveStore(database: typeof db): DriveStore {
  return {
    async getUser(id) {
      const [row] = await database.select().from(user).where(eq(user.id, id));
      return row
        ? {
            id: row.id,
            name: row.name,
            email: row.email,
            role: row.role ?? "user",
            banned: row.banned ?? false,
          }
        : null;
    },
    async listUsers() {
      const rows = await database.select().from(user).orderBy(user.name);
      return rows.map((row) => ({
        id: row.id,
        name: row.name,
        email: row.email,
        role: row.role ?? "user",
        banned: row.banned ?? false,
      }));
    },
    async grantsForUser(userId) {
      const memberships = await database
        .select({ groupId: groupMembers.groupId })
        .from(groupMembers)
        .where(eq(groupMembers.userId, userId));
      const groupIds = memberships.map((row) => row.groupId);
      const rows = await database
        .select()
        .from(grants)
        .where(
          or(
            and(eq(grants.subjectType, "user"), eq(grants.subjectId, userId)),
            groupIds.length
              ? and(
                  eq(grants.subjectType, "group"),
                  inArray(grants.subjectId, groupIds),
                )
              : undefined,
          ),
        );
      return rows.map(toGrant);
    },
    async grantsForPath(path) {
      return (
        await database.select().from(grants).where(eq(grants.path, path))
      ).map(toGrant);
    },
    async saveGrant(grant) {
      await database
        .insert(grants)
        .values({
          id: grant.id,
          path: grant.path,
          subjectType: grant.subject.type,
          subjectId: grant.subject.id,
          permission: grant.permission,
        })
        .onConflictDoUpdate({
          target: [grants.subjectType, grants.subjectId, grants.path],
          set: { permission: grant.permission },
        });
    },
    async removeGrant(id) {
      await database.delete(grants).where(eq(grants.id, id));
    },
    async listGroups() {
      const rows = await database.select().from(groups).orderBy(groups.name);
      const members = await database.select().from(groupMembers);
      return rows.map((row) => ({
        ...row,
        memberIds: members
          .filter((member) => member.groupId === row.id)
          .map((member) => member.userId),
      }));
    },
    async saveGroup(group) {
      await database.transaction(async (tx) => {
        await tx
          .insert(groups)
          .values({ id: group.id, name: group.name })
          .onConflictDoUpdate({ target: groups.id, set: { name: group.name } });
        await tx.delete(groupMembers).where(eq(groupMembers.groupId, group.id));
        if (group.memberIds.length)
          await tx
            .insert(groupMembers)
            .values(
              group.memberIds.map((userId) => ({ groupId: group.id, userId })),
            );
      });
    },
    async removeGroup(id) {
      await database.transaction(async (tx) => {
        await tx
          .delete(grants)
          .where(
            and(eq(grants.subjectType, "group"), eq(grants.subjectId, id)),
          );
        await tx.delete(groups).where(eq(groups.id, id));
      });
    },
    async createShare(share) {
      await database.insert(shares).values(share);
    },
    async getShare(token) {
      return (
        (
          await database.select().from(shares).where(eq(shares.token, token))
        )[0] ?? null
      );
    },
    async listShares(userId) {
      return database.select().from(shares).where(eq(shares.createdBy, userId));
    },
    async revokeShare(id, userId) {
      await database
        .delete(shares)
        .where(and(eq(shares.id, id), eq(shares.createdBy, userId)));
    },
    async countDownload(id) {
      await database
        .update(shares)
        .set({ downloadCount: sql`${shares.downloadCount} + 1` })
        .where(eq(shares.id, id));
    },
    async addTrash(item) {
      await database.insert(trash).values(item);
    },
    async getTrash(id) {
      return (
        (await database.select().from(trash).where(eq(trash.id, id)))[0] ?? null
      );
    },
    async listTrash(userId) {
      return database
        .select()
        .from(trash)
        .where(userId === null ? undefined : eq(trash.deletedBy, userId));
    },
    async removeTrash(id) {
      await database.delete(trash).where(eq(trash.id, id));
    },
    async listBookmarks(userId) {
      return database
        .select()
        .from(bookmarks)
        .where(eq(bookmarks.userId, userId));
    },
    async saveBookmark(userId, bookmark) {
      await database
        .insert(bookmarks)
        .values({ userId, ...bookmark })
        .onConflictDoUpdate({
          target: [bookmarks.userId, bookmarks.path],
          set: bookmark,
        });
    },
    async listAppPasswords(userId) {
      return database
        .select()
        .from(appPasswords)
        .where(eq(appPasswords.userId, userId));
    },
    async addAppPassword(password) {
      await database.insert(appPasswords).values(password);
    },
    async findAppPassword(tokenHash) {
      return (
        (
          await database
            .select()
            .from(appPasswords)
            .where(eq(appPasswords.tokenHash, tokenHash))
        )[0] ?? null
      );
    },
    async removeAppPassword(id, userId) {
      await database
        .delete(appPasswords)
        .where(and(eq(appPasswords.id, id), eq(appPasswords.userId, userId)));
    },
    async forgetPath(path) {
      await database.transaction(async (tx) => {
        // Compare path segments in JS so SQL wildcard characters in filenames stay literal.
        const matchingGrants = (await tx.select().from(grants))
          .filter((row) => isWithinPath(path, row.path))
          .map((row) => row.id);
        const matchingShares = (await tx.select().from(shares))
          .filter((row) => isWithinPath(path, row.path))
          .map((row) => row.id);
        const matchingBookmarks = (await tx.select().from(bookmarks)).filter(
          (row) => isWithinPath(path, row.path),
        );
        if (matchingGrants.length)
          await tx.delete(grants).where(inArray(grants.id, matchingGrants));
        if (matchingShares.length)
          await tx.delete(shares).where(inArray(shares.id, matchingShares));
        for (const row of matchingBookmarks)
          await tx
            .delete(bookmarks)
            .where(
              and(
                eq(bookmarks.userId, row.userId),
                eq(bookmarks.path, row.path),
              ),
            );
      });
    },
  };
}
