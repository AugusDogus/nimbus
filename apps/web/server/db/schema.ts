import { sql } from "drizzle-orm";
import {
  index,
  integer,
  sqliteTableCreator,
  text,
} from "drizzle-orm/sqlite-core";

import { user } from "./auth-schema";

export const createTable = sqliteTableCreator((name) => `nimbus_${name}`);

export const notes = createTable(
  "note",
  (d) => ({
    id: d.integer({ mode: "number" }).primaryKey({ autoIncrement: true }),
    title: d.text({ length: 256 }).notNull(),
    body: d.text(),
    createdAt: d
      .integer({ mode: "timestamp" })
      .default(sql`(unixepoch())`)
      .notNull(),
    updatedAt: d.integer({ mode: "timestamp" }).$onUpdate(() => new Date()),
  }),
  (t) => [index("note_title_idx").on(t.title)],
);

export const userPreferences = createTable("user_preferences", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  view: text("view").notNull(),
  sortField: text("sort_field").notNull(),
  sortDirection: text("sort_direction").notNull(),
  groupByType: integer("group_by_type", { mode: "boolean" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
    .$onUpdate(() => /* @__PURE__ */ new Date())
    .notNull(),
});

export * from "./auth-schema";

export * from "./drive-schema";

export * from "./audit-schema";
export * from "./file-request-schema";
export * from "./file-version-schema";
export * from "./mcp-schema";
export * from "./library-schema";
