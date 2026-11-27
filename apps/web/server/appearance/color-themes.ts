import { eq } from "drizzle-orm";
import { ThemePreferences, type ThemeChange } from "@/lib/theme-preferences";
import type { ThemeResult } from "@/lib/vscode-theme";
import type { db as database } from "../db";
import { userAppearance } from "../db/schema";

type Database = typeof database;

/**
 * An account's color themes on the server: what it imported and which it chose for light and
 * dark. Browsers change it one step at a time, so two devices changing it together each keep
 * their change; each read-modify-write runs in one synchronous transaction.
 */
function read(tx: Pick<Database, "select">, userId: string) {
  const [row] = tx
    .select({ colorThemes: userAppearance.colorThemes })
    .from(userAppearance)
    .where(eq(userAppearance.userId, userId))
    .all();
  if (!row || row.colorThemes === null) return null;
  // Only values that passed the schema are written, so a failure here is corruption.
  const parsed = ThemePreferences.parse(row.colorThemes);
  return parsed.ok ? parsed.value : null;
}

function write(
  tx: Pick<Database, "insert">,
  userId: string,
  value: ThemePreferences,
) {
  const colorThemes = JSON.stringify(value);
  tx.insert(userAppearance)
    .values({ userId, colorThemes })
    .onConflictDoUpdate({
      target: userAppearance.userId,
      set: { colorThemes, updatedAt: new Date() },
    })
    .run();
}

export const ColorThemes = {
  /** The account's themes, or null before any browser synced them. */
  get(db: Database, userId: string): ThemePreferences | null {
    return read(db, userId);
  },
  change(
    db: Database,
    userId: string,
    change: ThemeChange,
  ): ThemeResult<ThemePreferences> {
    return db.transaction((tx) => {
      const next = ThemePreferences.apply(
        read(tx, userId) ?? ThemePreferences.empty,
        change,
      );
      if (next.ok) write(tx, userId, next.value);
      return next;
    });
  },
  /** Folds a browser's pre-sync themes into the account's copy. See `ThemePreferences.merge`. */
  migrate(
    db: Database,
    userId: string,
    local: ThemePreferences,
  ): ThemePreferences {
    return db.transaction((tx) => {
      const merged = ThemePreferences.merge(read(tx, userId), local);
      write(tx, userId, merged);
      return merged;
    });
  },
} as const;
