import { and, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { z } from "zod";
import {
  permissionSchema,
  type DriveStore,
  type Grant,
} from "@nimbus/api/drive-store";
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

type Transaction = Parameters<Parameters<(typeof db)["transaction"]>[0]>[0];

/** Records detached from a trashed item's path, persisted as JSON on its trash row. */
const detachedAccessSchema = z.object({
  grants: z.array(
    z.object({
      id: z.string(),
      subjectType: z.enum(["user", "group"]),
      subjectId: z.string(),
      path: z.string(),
      permission: permissionSchema,
    }),
  ),
  shares: z.array(
    z.object({
      id: z.string(),
      token: z.string(),
      path: z.string(),
      createdBy: z.string(),
      createdAt: z.number(),
      expiresAt: z.number().nullable(),
      passwordHash: z.string().nullable(),
      downloadCount: z.number(),
    }),
  ),
  bookmarks: z.array(
    z.object({
      userId: z.string(),
      path: z.string(),
      starred: z.boolean(),
      accessedAt: z.number(),
    }),
  ),
});
type DetachedAccess = z.infer<typeof detachedAccessSchema>;

const trashColumns = {
  id: trash.id,
  path: trash.path,
  deletedBy: trash.deletedBy,
  deletedAt: trash.deletedAt,
  expiresAt: trash.expiresAt,
};

/** Match a path and its descendants. Comparing a prefix keeps SQL wildcard characters literal. */
function atOrUnder(column: SQLiteColumn, path: string): SQL {
  if (!path)
    throw new Error(
      "Nimbus refused to rewrite sharing records for the drive root. The root cannot be moved or trashed; no records were changed.",
    );
  return or(
    eq(column, path),
    sql`substr(${column}, 1, length(${path}) + 1) = ${path} || '/'`,
  ) ?? sql`0`;
}

/** Delete and return every link, grant, and bookmark at or under a path. */
async function detach(tx: Transaction, path: string): Promise<DetachedAccess> {
  const detached = {
    grants: await tx.select().from(grants).where(atOrUnder(grants.path, path)),
    shares: await tx.select().from(shares).where(atOrUnder(shares.path, path)),
    bookmarks: await tx
      .select()
      .from(bookmarks)
      .where(atOrUnder(bookmarks.path, path)),
  };
  await tx.delete(grants).where(atOrUnder(grants.path, path));
  await tx.delete(shares).where(atOrUnder(shares.path, path));
  await tx.delete(bookmarks).where(atOrUnder(bookmarks.path, path));
  return detached;
}

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
      await database.transaction(async (tx) => {
        const detached = await detach(tx, item.path);
        await tx
          .insert(trash)
          .values({ ...item, detachedAccess: JSON.stringify(detached) });
      });
    },
    async getTrash(id) {
      return (
        (
          await database.select(trashColumns).from(trash).where(eq(trash.id, id))
        )[0] ?? null
      );
    },
    async listTrash(userId) {
      return database
        .select(trashColumns)
        .from(trash)
        .where(userId === null ? undefined : eq(trash.deletedBy, userId));
    },
    async restoreTrash(id) {
      await database.transaction(async (tx) => {
        const [item] = await tx.select().from(trash).where(eq(trash.id, id));
        if (!item) return;
        const parsed = detachedAccessSchema.safeParse(
          JSON.parse(item.detachedAccess),
        );
        if (!parsed.success)
          throw new Error(
            `Nimbus could not read the saved sharing records for trash item ${id} (${item.path}): ${parsed.error.message}. The item is still in trash; restore was not completed.`,
          );
        // Records now at the vacant path were left by content removed outside Nimbus.
        await detach(tx, item.path);
        const userIds = new Set(
          (await tx.select({ id: user.id }).from(user)).map((row) => row.id),
        );
        const groupIds = new Set(
          (await tx.select({ id: groups.id }).from(groups)).map((row) => row.id),
        );
        // Accounts and groups removed while the item was in trash lose their records.
        const restoredGrants = parsed.data.grants.filter((row) =>
          (row.subjectType === "user" ? userIds : groupIds).has(row.subjectId),
        );
        const restoredShares = parsed.data.shares.filter((row) =>
          userIds.has(row.createdBy),
        );
        const restoredBookmarks = parsed.data.bookmarks.filter((row) =>
          userIds.has(row.userId),
        );
        if (restoredGrants.length)
          await tx.insert(grants).values(restoredGrants);
        if (restoredShares.length)
          await tx.insert(shares).values(restoredShares);
        if (restoredBookmarks.length)
          await tx.insert(bookmarks).values(restoredBookmarks);
        await tx.delete(trash).where(eq(trash.id, id));
      });
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
    async discardPath(path) {
      await database.transaction((tx) => detach(tx, path));
    },
    async movePath(from, to) {
      await database.transaction(async (tx) => {
        await detach(tx, to);
        const moved = (column: SQLiteColumn) =>
          sql`${to} || substr(${column}, length(${from}) + 1)`;
        await tx
          .update(grants)
          .set({ path: moved(grants.path) })
          .where(atOrUnder(grants.path, from));
        await tx
          .update(shares)
          .set({ path: moved(shares.path) })
          .where(atOrUnder(shares.path, from));
        await tx
          .update(bookmarks)
          .set({ path: moved(bookmarks.path) })
          .where(atOrUnder(bookmarks.path, from));
      });
    },
  };
}
