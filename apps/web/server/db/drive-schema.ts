import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { user } from "./auth-schema";

export const groups = sqliteTable("nimbus_group", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
});
export const groupMembers = sqliteTable(
  "nimbus_group_member",
  {
    groupId: text("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => [primaryKey({ columns: [table.groupId, table.userId] })],
);
export const grants = sqliteTable(
  "nimbus_grant",
  {
    id: text("id").primaryKey(),
    subjectType: text("subject_type", { enum: ["user", "group"] }).notNull(),
    subjectId: text("subject_id").notNull(),
    path: text("path").notNull(),
    permission: text("permission", {
      enum: ["read", "write", "admin"],
    }).notNull(),
  },
  (table) => [
    uniqueIndex("nimbus_grant_subject_path").on(
      table.subjectType,
      table.subjectId,
      table.path,
    ),
    // Renames, moves and trash rewrite records under a path prefix.
    index("nimbus_grant_path").on(table.path),
    // Finds records under any spelling of a path Nimbus is about to create; see VacantPath.
    index("nimbus_grant_path_nocase").on(sql`${table.path} COLLATE NOCASE`),
  ],
);
export const shares = sqliteTable(
  "nimbus_share",
  {
    id: text("id").primaryKey(),
    token: text("token").notNull().unique(),
    path: text("path").notNull(),
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at"),
    passwordHash: text("password_hash"),
    downloadCount: integer("download_count").notNull().default(0),
    maxDownloads: integer("max_downloads"),
    mode: text("mode", { enum: ["download", "view"] })
      .notNull()
      .default("download"),
  },
  (table) => [
    index("nimbus_share_path").on(table.path),
    index("nimbus_share_path_nocase").on(sql`${table.path} COLLATE NOCASE`),
  ],
);
/**
 * Links their owner turned off, by the SHA-256 of their token, so a visitor opening one is told
 * so. A token never issued has no row and stays indistinguishable from any other unknown one.
 * Kept for 90 days and at most 1,000 per owner (see `RevokedShares`), so it stays small.
 */
export const revokedShares = sqliteTable(
  "nimbus_revoked_share",
  {
    tokenHash: text("token_hash").primaryKey(),
    owner: text("owner")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    revokedAt: integer("revoked_at").notNull(),
  },
  (table) => [
    index("nimbus_revoked_share_owner").on(table.owner, table.revokedAt),
    index("nimbus_revoked_share_revoked_at").on(table.revokedAt),
  ],
);
export const trash = sqliteTable("nimbus_trash", {
  id: text("id").primaryKey(),
  path: text("path").notNull(),
  deletedBy: text("deleted_by")
    .notNull()
    .references(() => user.id),
  deletedAt: integer("deleted_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
  /** JSON links, direct grants, and bookmarks detached from the item's path until it is restored. */
  detachedAccess: text("detached_access")
    .notNull()
    .default('{"grants":[],"shares":[],"bookmarks":[],"properties":[]}'),
});
export const bookmarks = sqliteTable(
  "nimbus_bookmark",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    starred: integer("starred", { mode: "boolean" }).notNull().default(false),
    accessedAt: integer("accessed_at").notNull(),
    /** Opens of this item by this user, for ranking frequent ones first in search. */
    visits: integer("visits").notNull().default(1),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.path] }),
    index("nimbus_bookmark_path").on(table.path),
    index("nimbus_bookmark_path_nocase").on(sql`${table.path} COLLATE NOCASE`),
  ],
);
export const appPasswords = sqliteTable("nimbus_app_password", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  createdAt: integer("created_at").notNull(),
});
/** WebDAV dead properties (RFC 4918, section 4), stored as self-contained XML elements. */
export const davProperties = sqliteTable(
  "nimbus_dav_property",
  {
    path: text("path").notNull(),
    namespace: text("namespace").notNull(),
    name: text("name").notNull(),
    xml: text("xml").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.path, table.namespace, table.name] }),
    index("nimbus_dav_property_path_nocase").on(
      sql`${table.path} COLLATE NOCASE`,
    ),
  ],
);
/** Each account's personal folder. Files stay on disk when the account is removed. */
export const homes = sqliteTable("nimbus_home", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  path: text("path").notNull().unique(),
});
/**
 * Folders Nimbus created to hold home folders. Home folders go only into a recorded folder,
 * never into one that existed before, which may already be shared.
 */
export const homeContainers = sqliteTable("nimbus_home_container", {
  path: text("path").primaryKey(),
  createdAt: integer("created_at").notNull(),
});
/**
 * Server-wide settings administrators change in Settings, one row (id 0). Sharing the folder
 * that holds every home folder, or a folder above it, is refused unless it is allowed here.
 */
export const serverSettings = sqliteTable(
  "nimbus_server_setting",
  {
    id: integer("id").primaryKey(),
    allowHomeContainerSharing: integer("allow_home_container_sharing", {
      mode: "boolean",
    })
      .notNull()
      .default(false),
    updatedAt: integer("updated_at"),
    updatedBy: text("updated_by").references(() => user.id, {
      onDelete: "set null",
    }),
  },
  () => [check("nimbus_server_setting_single_row", sql`id = 0`)],
);
/**
 * Changes whose filesystem step and database step a crash could separate: moving an item to
 * trash, restoring it, and moving or renaming it. Each row is written in a transaction before
 * or with the first step and deleted with the last, so a row left behind names a change that
 * startup finishes or undoes. `trash_id` is set for trash and restore, the paths for moves.
 */
export const pendingChanges = sqliteTable(
  "nimbus_pending_change",
  {
    id: text("id").primaryKey(),
    kind: text("kind", { enum: ["trash", "restore", "move"] }).notNull(),
    trashId: text("trash_id"),
    fromPath: text("from_path"),
    toPath: text("to_path"),
    /** The item's device and inode, so recovery never acts on other content found there. */
    identity: text("identity").notNull(),
    createdAt: integer("created_at").notNull(),
    /**
     * The server process that recorded it (see ServerRun.processId): another process recovers it
     * only once that one is known to have died. Null for changes recorded before this was kept.
     */
    owner: text("owner"),
  },
  () => [
    check(
      "nimbus_pending_change_shape",
      sql`(kind IN ('trash', 'restore') AND trash_id IS NOT NULL AND from_path IS NULL AND to_path IS NULL) OR (kind = 'move' AND trash_id IS NULL AND from_path IS NOT NULL AND to_path IS NOT NULL)`,
    ),
  ],
);
/**
 * One row (id 0) whose value triggers from migration 0006 bump whenever anything a permission
 * check reads changes. That migration declares the check on the column; it is named here so
 * a generated table rebuild keeps it.
 */
export const accessEpoch = sqliteTable(
  "nimbus_access_epoch",
  {
    id: integer("id").primaryKey(),
    value: integer("value").notNull(),
  },
  () => [check("nimbus_access_epoch_single_row", sql`id = 0`)],
);

/**
 * Transfer receipts already undone, by receipt id, until they would have expired anyway. In
 * the database rather than in memory so that two servers running side by side during an update
 * cannot both undo one receipt: claiming the row is what allows an undo.
 */
export const undoneReceipts = sqliteTable(
  "nimbus_undone_receipt",
  {
    id: text("id").primaryKey(),
    expiresAt: integer("expires_at").notNull(),
  },
  (table) => [index("nimbus_undone_receipt_expiry").on(table.expiresAt)],
);

/**
 * Active WebDAV locks (see FileLockStore in file-mutations.ts), in the database so that they
 * outlive the server process that granted them: during an update the next server honours them.
 * Rows past `expires_at` are expired locks, ignored and deleted as locks are next changed.
 */
export const davLocks = sqliteTable(
  "nimbus_dav_lock",
  {
    token: text("token").primaryKey(),
    path: text("path").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    scope: text("scope", { enum: ["exclusive", "shared"] }).notNull(),
    depth: text("depth", { enum: ["0", "infinity"] }).notNull(),
    owner: text("owner").notNull(),
    timeoutSeconds: integer("timeout_seconds").notNull(),
    expiresAt: integer("expires_at").notNull(),
  },
  (table) => [index("nimbus_dav_lock_expiry").on(table.expiresAt)],
);

/**
 * Password guess budgets (see GuessBudgets), per limiter and key: the time at which the key's
 * budget is whole again, as the GCRA limiter keeps it. In the database so that a restart or an
 * update never hands a guesser a fresh budget, and every server process counts the same guesses.
 */
export const guessBudgets = sqliteTable(
  "nimbus_guess_budget",
  {
    name: text("name").notNull(),
    key: text("key").notNull(),
    tat: integer("tat").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.name, table.key] }),
    index("nimbus_guess_budget_tat").on(table.tat),
  ],
);

/** Better Auth's request limits (sign-in among them), per key, in fixed windows. */
export const authRateLimits = sqliteTable(
  "nimbus_auth_rate_limit",
  {
    key: text("key").primaryKey(),
    count: integer("count").notNull(),
    windowStart: integer("window_start").notNull(),
    windowEnd: integer("window_end").notNull(),
  },
  (table) => [index("nimbus_auth_rate_limit_end").on(table.windowEnd)],
);

/**
 * One-time codes already accepted, such as authenticator codes (see GuessBudgets), by a hash of
 * the account and the code, until they could no longer be valid anyway: every server process
 * refuses them again, also across an update.
 */
export const spentCodes = sqliteTable(
  "nimbus_spent_code",
  {
    key: text("key").primaryKey(),
    expiresAt: integer("expires_at").notNull(),
  },
  (table) => [index("nimbus_spent_code_expiry").on(table.expiresAt)],
);
