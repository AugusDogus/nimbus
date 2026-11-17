import { and, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  permissionSchema,
  shareModeSchema,
  type DriveStore,
  type Grant,
  type PendingChange,
} from "@nimbus/api/drive-store";
import { FileVersions } from "@nimbus/api/file-versions";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import type { Database } from "./db";
import {
  createFileRequestStore,
  FileRequestRecords,
} from "./file-request-store";
import { createFileVersionStore } from "./file-version-store";
import { atOrUnder, relocated } from "./db/path-prefix";
import {
  appPasswords,
  bookmarks,
  davProperties,
  fileRequests,
  fileVersions,
  grants,
  groupMembers,
  groups,
  homeContainers,
  homes,
  pendingChanges,
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

/**
 * A synchronous transaction. Every statement inside one runs with `.run()`, `.all()` or
 * `.get()` and nothing is awaited, so SQLite commits exactly the work the callback did.
 */
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** Insert rows in batches that stay below SQLite's bound-parameter limit. */
function insertChunked<T extends SQLiteTable>(
  tx: Transaction,
  table: T,
  rows: readonly T["$inferInsert"][],
) {
  for (let start = 0; start < rows.length; start += 500)
    tx.insert(table)
      .values(rows.slice(start, start + 500))
      .run();
}

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
      maxDownloads: z.number().nullable(),
      mode: shareModeSchema,
    }),
  ),
  bookmarks: z.array(
    z.object({
      userId: z.string(),
      path: z.string(),
      starred: z.boolean(),
      accessedAt: z.number(),
      // Detached before visits were counted.
      visits: z.number().default(1),
    }),
  ),
  properties: z.array(
    z.object({
      path: z.string(),
      namespace: z.string(),
      name: z.string(),
      xml: z.string(),
    }),
  ),
  // Trash rows written before file requests existed have no such key.
  fileRequests: FileRequestRecords.schema.default(FileRequestRecords.empty),
});
type DetachedAccess = z.infer<typeof detachedAccessSchema>;

const trashColumns = {
  id: trash.id,
  path: trash.path,
  deletedBy: trash.deletedBy,
  deletedAt: trash.deletedAt,
  expiresAt: trash.expiresAt,
};

/** Delete and return every link, file request, grant, bookmark, and dead property at or under a path. */
function detach(tx: Transaction, path: string): DetachedAccess {
  const detached = {
    fileRequests: FileRequestRecords.detach(tx, path),
    grants: tx.select().from(grants).where(atOrUnder(grants.path, path)).all(),
    shares: tx.select().from(shares).where(atOrUnder(shares.path, path)).all(),
    bookmarks: tx
      .select()
      .from(bookmarks)
      .where(atOrUnder(bookmarks.path, path))
      .all(),
    properties: tx
      .select()
      .from(davProperties)
      .where(atOrUnder(davProperties.path, path))
      .all(),
  };
  tx.delete(grants).where(atOrUnder(grants.path, path)).run();
  tx.delete(shares).where(atOrUnder(shares.path, path)).run();
  tx.delete(bookmarks).where(atOrUnder(bookmarks.path, path)).run();
  tx.delete(davProperties).where(atOrUnder(davProperties.path, path)).run();
  return detached;
}

/**
 * Move file history at or under `from` to the same relative location under `to`, first
 * dropping history left at `to` by content removed outside Nimbus. Payloads of dropped
 * records are swept by version cleanup a day later.
 */
function relocateVersions(tx: Transaction, from: string, to: string) {
  tx.delete(fileVersions).where(atOrUnder(fileVersions.path, to)).run();
  tx.update(fileVersions)
    .set({ path: relocated(fileVersions.path, from, to) })
    .where(atOrUnder(fileVersions.path, from))
    .run();
}

export function createDriveStore(database: Database): DriveStore {
  return {
    async accessEpoch() {
      const [row] = database.all<{ value: number }>(
        sql`SELECT value FROM nimbus_access_epoch WHERE id = 0`,
      );
      if (!row)
        throw new Error(
          "The nimbus_access_epoch row is missing, so Nimbus cannot tell whether cached permissions are current. Restart Nimbus to rerun its migrations; no data was changed.",
        );
      return row.value;
    },
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
      database.transaction((tx) => {
        tx.insert(groups)
          .values({ id: group.id, name: group.name })
          .onConflictDoUpdate({ target: groups.id, set: { name: group.name } })
          .run();
        tx.delete(groupMembers).where(eq(groupMembers.groupId, group.id)).run();
        if (group.memberIds.length)
          tx.insert(groupMembers)
            .values(
              group.memberIds.map((userId) => ({ groupId: group.id, userId })),
            )
            .run();
      });
    },
    async removeGroup(id) {
      database.transaction((tx) => {
        tx.delete(grants)
          .where(and(eq(grants.subjectType, "group"), eq(grants.subjectId, id)))
          .run();
        tx.delete(groups).where(eq(groups.id, id)).run();
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
    async updateShare(id, userId, settings) {
      const [row] = await database
        .update(shares)
        .set(settings)
        .where(and(eq(shares.id, id), eq(shares.createdBy, userId)))
        .returning();
      return row ?? null;
    },
    async revokeShare(id, userId) {
      await database
        .delete(shares)
        .where(and(eq(shares.id, id), eq(shares.createdBy, userId)));
    },
    async claimDownload(id) {
      const claimed = await database
        .update(shares)
        .set({ downloadCount: sql`${shares.downloadCount} + 1` })
        .where(
          and(
            eq(shares.id, id),
            or(
              isNull(shares.maxDownloads),
              lt(shares.downloadCount, shares.maxDownloads),
            ),
          ),
        )
        .returning({ id: shares.id });
      return claimed.length > 0;
    },
    async addTrash(item) {
      database.transaction((tx) => {
        const detached = detach(tx, item.path);
        tx.insert(trash)
          .values({ ...item, detachedAccess: JSON.stringify(detached) })
          .run();
        // History waits at the item's trash location, where it never matches a live path.
        relocateVersions(tx, item.path, FileVersions.trashLocation(item.id));
      });
    },
    async getTrash(id) {
      return (
        (
          await database
            .select(trashColumns)
            .from(trash)
            .where(eq(trash.id, id))
        )[0] ?? null
      );
    },
    async detachedGrantsFor(id, userId) {
      const [row] = await database
        .select({ detachedAccess: trash.detachedAccess })
        .from(trash)
        .where(eq(trash.id, id));
      if (!row) return [];
      const parsed = detachedAccessSchema
        .pick({ grants: true })
        .safeParse(JSON.parse(row.detachedAccess));
      if (!parsed.success)
        throw new Error(
          `Nimbus could not read the saved grants of trash item ${id}: ${parsed.error.message}. The item is still in trash; nothing was changed.`,
        );
      const memberships = new Set(
        (
          await database
            .select({ groupId: groupMembers.groupId })
            .from(groupMembers)
            .where(eq(groupMembers.userId, userId))
        ).map((membership) => membership.groupId),
      );
      return parsed.data.grants
        .filter((grant) =>
          grant.subjectType === "user"
            ? grant.subjectId === userId
            : memberships.has(grant.subjectId),
        )
        .map(toGrant);
    },
    async listTrash(userId) {
      return database
        .select(trashColumns)
        .from(trash)
        .where(userId === null ? undefined : eq(trash.deletedBy, userId));
    },
    async restoreTrash(id) {
      database.transaction((tx) => {
        const item = tx.select().from(trash).where(eq(trash.id, id)).get();
        if (!item) return;
        const parsed = detachedAccessSchema.safeParse(
          JSON.parse(item.detachedAccess),
        );
        if (!parsed.success)
          throw new Error(
            `Nimbus could not read the saved sharing records for trash item ${id} (${item.path}): ${parsed.error.message}. The item is still in trash; restore was not completed.`,
          );
        // Records now at the vacant path were left by content removed outside Nimbus.
        detach(tx, item.path);
        relocateVersions(tx, FileVersions.trashLocation(item.id), item.path);
        const userIds = new Set(
          tx
            .select({ id: user.id })
            .from(user)
            .all()
            .map((row) => row.id),
        );
        const groupIds = new Set(
          tx
            .select({ id: groups.id })
            .from(groups)
            .all()
            .map((row) => row.id),
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
        insertChunked(tx, grants, restoredGrants);
        insertChunked(tx, shares, restoredShares);
        insertChunked(tx, bookmarks, restoredBookmarks);
        insertChunked(tx, davProperties, parsed.data.properties);
        FileRequestRecords.reattach(tx, parsed.data.fileRequests, userIds);
        tx.delete(trash).where(eq(trash.id, id)).run();
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
    async recordBookmark(userId, path, change, at) {
      const opened = change.type === "open";
      await database
        .insert(bookmarks)
        .values({
          userId,
          path,
          starred: opened ? false : change.starred,
          accessedAt: at,
          visits: opened ? 1 : 0,
        })
        .onConflictDoUpdate({
          target: [bookmarks.userId, bookmarks.path],
          set: opened
            ? { accessedAt: at, visits: sql`${bookmarks.visits} + 1` }
            : { starred: change.starred },
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
    fileRequests: createFileRequestStore(database),
    versions: createFileVersionStore(database),
    async caseVariants(path) {
      const variants = new Set<string>();
      for (const table of [grants, shares, fileRequests]) {
        // The leading part of each path with as many characters as `path`, compared without
        // case; small tables, so scanned rather than indexed.
        const prefix = sql`substr(${table.path}, 1, ${path.length})`;
        const rows = await database
          .selectDistinct({ prefix: sql<string>`${prefix}` })
          .from(table)
          .where(
            and(
              sql`lower(${prefix}) = lower(${path})`,
              sql`${prefix} <> ${path}`,
              or(
                sql`length(${table.path}) = ${path.length}`,
                sql`substr(${table.path}, ${path.length + 1}, 1) = '/'`,
              ),
            ),
          );
        for (const row of rows) variants.add(row.prefix);
      }
      return [...variants];
    },
    async claimVacant(path) {
      // Deletes only: a vacant path usually has no records, and these are index range scans.
      database.transaction((tx) => {
        for (const table of [
          grants,
          shares,
          bookmarks,
          davProperties,
          fileRequests,
          fileVersions,
        ])
          tx.delete(table).where(atOrUnder(table.path, path)).run();
      });
    },
    async addPendingChange(change) {
      await database.insert(pendingChanges).values({
        id: change.id,
        kind: change.kind,
        trashId: change.kind === "move" ? null : change.trashId,
        fromPath: change.kind === "move" ? change.from : null,
        toPath: change.kind === "move" ? change.to : null,
        createdAt: Date.now(),
      });
    },
    async removePendingChange(id) {
      await database.delete(pendingChanges).where(eq(pendingChanges.id, id));
    },
    async listPendingChanges() {
      return (await database.select().from(pendingChanges)).map(
        (row): PendingChange => {
          if (
            row.kind === "move" &&
            row.fromPath !== null &&
            row.toPath !== null
          )
            return {
              id: row.id,
              kind: "move",
              from: row.fromPath,
              to: row.toPath,
            };
          if (row.kind !== "move" && row.trashId !== null)
            return { id: row.id, kind: row.kind, trashId: row.trashId };
          // The table's check constraint rules this out.
          throw new Error(
            `Pending change ${row.id} (${row.kind}) is missing its trash id or paths, so Nimbus cannot finish or undo it. Nothing was changed; delete the row from nimbus_pending_change after checking the item by hand.`,
          );
        },
      );
    },
    async movePath(from, to, settles) {
      database.transaction((tx) => {
        if (settles !== undefined)
          tx.delete(pendingChanges).where(eq(pendingChanges.id, settles)).run();
        detach(tx, to);
        relocateVersions(tx, from, to);
        for (const table of [grants, shares, bookmarks, davProperties])
          tx.update(table)
            .set({ path: relocated(table.path, from, to) })
            .where(atOrUnder(table.path, from))
            .run();
        FileRequestRecords.relocate(tx, from, to);
      });
    },
    async homeOf(userId) {
      const [row] = await database
        .select()
        .from(homes)
        .where(eq(homes.userId, userId));
      return row?.path ?? null;
    },
    async listHomes() {
      return database.select().from(homes);
    },
    async hasHomeWithin(path) {
      if (!path)
        return (await database.select().from(homes).limit(1)).length > 0;
      return (
        (
          await database
            .select()
            .from(homes)
            .where(atOrUnder(homes.path, path))
            .limit(1)
        ).length > 0
      );
    },
    async createHome(home, grant) {
      database.transaction((tx) => {
        tx.insert(homes).values(home).run();
        tx.insert(grants)
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
          })
          .run();
      });
    },
    async listHomeContainers() {
      return (
        await database
          .select({ path: homeContainers.path })
          .from(homeContainers)
      ).map((row) => row.path);
    },
    async addHomeContainer(path) {
      await database
        .insert(homeContainers)
        .values({ path, createdAt: Date.now() });
    },
    async removeHomeContainer(path) {
      await database
        .delete(homeContainers)
        .where(eq(homeContainers.path, path));
    },
    async sharedPaths() {
      const paths = (
        table:
          | typeof grants
          | typeof shares
          | typeof fileRequests
          | typeof bookmarks,
      ) =>
        database
          .selectDistinct({ path: table.path })
          .from(table)
          .all()
          .map((row) => row.path);
      return {
        grants: paths(grants),
        links: paths(shares),
        fileRequests: paths(fileRequests),
        bookmarks: paths(bookmarks),
      };
    },
    async davProperties(paths) {
      const result = new Map<
        string,
        { namespace: string; name: string; xml: string }[]
      >();
      // Stay well below SQLite's bound-parameter limit for large folder listings.
      for (let start = 0; start < paths.length; start += 500) {
        const rows = await database
          .select()
          .from(davProperties)
          .where(inArray(davProperties.path, paths.slice(start, start + 500)));
        for (const { path, ...property } of rows)
          result.set(path, [...(result.get(path) ?? []), property]);
      }
      return result;
    },
    async patchDavProperties(path, set, remove) {
      database.transaction((tx) => {
        for (const property of remove)
          tx.delete(davProperties)
            .where(
              and(
                eq(davProperties.path, path),
                eq(davProperties.namespace, property.namespace),
                eq(davProperties.name, property.name),
              ),
            )
            .run();
        for (const property of set)
          tx.insert(davProperties)
            .values({ path, ...property })
            .onConflictDoUpdate({
              target: [
                davProperties.path,
                davProperties.namespace,
                davProperties.name,
              ],
              set: { xml: property.xml },
            })
            .run();
      });
    },
    async copyDavProperties(from, to) {
      database.transaction((tx) => {
        tx.delete(davProperties).where(atOrUnder(davProperties.path, to)).run();
        const rows = tx
          .select()
          .from(davProperties)
          .where(atOrUnder(davProperties.path, from))
          .all();
        insertChunked(
          tx,
          davProperties,
          rows.map((row) => ({
            ...row,
            path: to + row.path.slice(from.length),
          })),
        );
      });
    },
  };
}
