import { integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { user } from "./auth-schema";

export const groups = sqliteTable("nimbus_group", {
  id: text("id").primaryKey(), name: text("name").notNull().unique(),
});
export const groupMembers = sqliteTable("nimbus_group_member", {
  groupId: text("group_id").notNull().references(() => groups.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
}, (table) => [primaryKey({ columns: [table.groupId, table.userId] })]);
export const grants = sqliteTable("nimbus_grant", {
  id: text("id").primaryKey(),
  subjectType: text("subject_type", { enum: ["user", "group"] }).notNull(),
  subjectId: text("subject_id").notNull(),
  path: text("path").notNull(),
  permission: text("permission", { enum: ["read", "write", "admin"] }).notNull(),
}, (table) => [uniqueIndex("nimbus_grant_subject_path").on(table.subjectType, table.subjectId, table.path)]);
export const shares = sqliteTable("nimbus_share", {
  id: text("id").primaryKey(), token: text("token").notNull().unique(), path: text("path").notNull(),
  createdBy: text("created_by").notNull().references(() => user.id, { onDelete: "cascade" }),
  createdAt: integer("created_at").notNull(), expiresAt: integer("expires_at"),
  passwordHash: text("password_hash"), downloadCount: integer("download_count").notNull().default(0),
});
export const trash = sqliteTable("nimbus_trash", {
  id: text("id").primaryKey(), path: text("path").notNull(),
  deletedBy: text("deleted_by").notNull().references(() => user.id),
  deletedAt: integer("deleted_at").notNull(), expiresAt: integer("expires_at").notNull(),
  /** JSON links, direct grants, and bookmarks detached from the item's path until it is restored. */
  detachedAccess: text("detached_access").notNull().default('{"grants":[],"shares":[],"bookmarks":[],"properties":[]}'),
});
export const bookmarks = sqliteTable("nimbus_bookmark", {
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  path: text("path").notNull(), starred: integer("starred", { mode: "boolean" }).notNull().default(false),
  accessedAt: integer("accessed_at").notNull(),
}, (table) => [primaryKey({ columns: [table.userId, table.path] })]);
export const appPasswords = sqliteTable("nimbus_app_password", {
  id: text("id").primaryKey(), userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  name: text("name").notNull(), tokenHash: text("token_hash").notNull().unique(), createdAt: integer("created_at").notNull(),
});
/** WebDAV dead properties (RFC 4918, section 4), stored as self-contained XML elements. */
export const davProperties = sqliteTable("nimbus_dav_property", {
  path: text("path").notNull(), namespace: text("namespace").notNull(), name: text("name").notNull(),
  xml: text("xml").notNull(),
}, (table) => [primaryKey({ columns: [table.path, table.namespace, table.name] })]);
/** Each account's personal folder. Files stay on disk when the account is removed. */
export const homes = sqliteTable("nimbus_home", {
  userId: text("user_id").primaryKey().references(() => user.id, { onDelete: "cascade" }),
  path: text("path").notNull().unique(),
});
