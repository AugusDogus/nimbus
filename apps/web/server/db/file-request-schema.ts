import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { user } from "./auth-schema";

export const fileRequests = sqliteTable(
  "nimbus_file_request",
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
    note: text("note"),
    maxFileBytes: integer("max_file_bytes"),
    maxFiles: integer("max_files"),
    maxTotalBytes: integer("max_total_bytes"),
  },
  (table) => [index("nimbus_file_request_path").on(table.path)],
);

/** One row per anonymous upload: a quota reservation until it finishes. */
export const fileRequestUploads = sqliteTable(
  "nimbus_file_request_upload",
  {
    id: text("id").primaryKey(),
    requestId: text("request_id")
      .notNull()
      .references(() => fileRequests.id, { onDelete: "cascade" }),
    uploaderHash: text("uploader_hash").notNull(),
    size: integer("size").notNull(),
    createdAt: integer("created_at").notNull(),
    finishedAt: integer("finished_at"),
    name: text("name"),
  },
  (table) => [index("nimbus_file_request_upload_request").on(table.requestId)],
);
