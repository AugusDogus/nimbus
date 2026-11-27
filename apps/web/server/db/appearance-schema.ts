import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { user } from "./auth-schema";

/**
 * How an account's Nimbus looks, kept on the server so every browser it signs in on agrees:
 * its file icon set and its color themes. Browsers cache both to draw the first frame; this
 * row is the truth.
 */
export const userAppearance = sqliteTable("nimbus_user_appearance", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  /** A built-in set's id or an imported set's id; null for the default set. */
  iconTheme: text("icon_theme"),
  /**
   * Imported color themes and the light and dark choices, as `ThemePreferences` JSON. Null
   * until a browser first syncs, so the first one can bring the themes it saved locally.
   */
  colorThemes: text("color_themes"),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
    .$onUpdate(() => /* @__PURE__ */ new Date())
    .notNull(),
});

/**
 * An icon set an account imported from Open VSX. Its files live under the config root in
 * `icon-themes/imported/<id>`; only this account can read or choose it.
 */
export const importedIconTheme = sqliteTable(
  "nimbus_imported_icon_theme",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** `namespace.name@version` on Open VSX. */
    extension: text("extension").notNull(),
    /** The extension's declared licence, such as MIT, when it names one. */
    licence: text("licence"),
    bytes: integer("bytes").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
  },
  (table) => [index("imported_icon_theme_user_idx").on(table.userId)],
);
