import { sql } from "drizzle-orm";
import {
    index,
    sqliteTableCreator
} from "drizzle-orm/sqlite-core";

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
