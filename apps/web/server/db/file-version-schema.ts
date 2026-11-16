import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { user } from "./auth-schema";

/** Metadata for preserved file content stored under `.nimbus/versions`. */
export const fileVersions = sqliteTable(
  "nimbus_file_version",
  {
    id: text("id").primaryKey(),
    fileKey: text("file_key").notNull(),
    name: text("name").notNull(),
    size: integer("size").notNull(),
    modifiedAt: integer("modified_at").notNull(),
    archivedAt: integer("archived_at").notNull(),
    archivedBy: text("archived_by").references(() => user.id, {
      onDelete: "set null",
    }),
  },
  (table) => [
    index("nimbus_file_version_file").on(table.fileKey, table.archivedAt),
    index("nimbus_file_version_archived").on(table.archivedAt),
  ],
);
