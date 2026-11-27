import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { user } from "./auth-schema";

/**
 * How an account's Nimbus looks, kept on the server so every browser it signs in on agrees:
 * its file icon set. Browsers cache it to draw the first frame; this row is the truth.
 */
export const userAppearance = sqliteTable("nimbus_user_appearance", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  /** A built-in set's id or an imported set's id; null for the default set. */
  iconTheme: text("icon_theme"),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
    .$onUpdate(() => /* @__PURE__ */ new Date())
    .notNull(),
});
