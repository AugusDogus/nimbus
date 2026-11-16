import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { user } from "./auth-schema";

/** Metadata for preserved file content stored under `.nimbus/versions`. */
export const fileVersions = sqliteTable(
  "nimbus_file_version",
  {
    id: text("id").primaryKey(),
    /** Drive path of the file, or its location in trash; see FileVersion. */
    path: text("path").notNull(),
    name: text("name").notNull(),
    size: integer("size").notNull(),
    modifiedAt: integer("modified_at").notNull(),
    archivedAt: integer("archived_at").notNull(),
    archivedBy: text("archived_by").references(() => user.id, {
      onDelete: "set null",
    }),
  },
  (table) => [
    index("nimbus_file_version_path").on(table.path, table.archivedAt),
    index("nimbus_file_version_archived").on(table.archivedAt),
  ],
);
