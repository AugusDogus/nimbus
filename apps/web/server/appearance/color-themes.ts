import { eq } from "drizzle-orm";
import * as z from "zod/mini";
import { ThemePreferences, type ThemeChange } from "@/lib/theme-preferences";
import { BuiltInThemes } from "@/lib/built-in-themes";
import {
  importedThemeSchema,
  type ThemeResult,
  type VsCodeTheme,
} from "@/lib/vscode-theme";
import type { db as database } from "../db";
import { userAppearance } from "../db/schema";

type Database = typeof database;

const themeId = z.string().check(z.minLength(1), z.maxLength(200));
/** A change a browser sends, checked here; see `ThemeChange`. */
export const themeChangeSchema: z.ZodMiniType<ThemeChange> = z.union([
  z.object({
    kind: z.literal("install"),
    themes: z.array(importedThemeSchema).check(z.minLength(1), z.maxLength(40)),
  }),
  z.object({
    kind: z.literal("select"),
    appearance: z.enum(["light", "dark"]),
    id: z.nullable(themeId),
  }),
  z.object({ kind: z.literal("remove"), id: themeId }),
  z.object({ kind: z.literal("reset") }),
]);

/** The same theme, imported separately: same name, appearance and colors. */
const sameTheme = (a: VsCodeTheme, b: VsCodeTheme) =>
  a.name === b.name &&
  a.appearance === b.appearance &&
  JSON.stringify(a.colors) === JSON.stringify(b.colors);

/**
 * Folds themes saved in one browser before themes synced into the account's server copy, once.
 * The server's themes and choices win; the browser adds themes the server lacks (up to the
 * limit) and fills a light or dark choice the server has not made.
 */
export function mergeColorThemes(
  server: ThemePreferences | null,
  local: ThemePreferences,
): ThemePreferences {
  if (server === null) return local;
  const themes = [...server.themes];
  for (const theme of local.themes)
    if (
      themes.length < 100 &&
      !themes.some((known) => known.id === theme.id || sameTheme(known, theme))
    )
      themes.push(theme);
  const merged: ThemePreferences = { ...server, themes };
  for (const mode of ["light", "dark"] as const) {
    if (server[mode] !== null || local[mode] === null) continue;
    const wanted = local.themes.find((theme) => theme.id === local[mode]);
    const kept = wanted
      ? themes.find((theme) => sameTheme(theme, wanted))
      : BuiltInThemes.all.find((theme) => theme.id === local[mode]);
    if (kept) merged[mode] = kept.id;
  }
  const checked = ThemePreferences.schema.safeParse(merged);
  return checked.success ? checked.data : server;
}

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
  /** Folds a browser's pre-sync themes into the account's copy. See `mergeColorThemes`. */
  migrate(
    db: Database,
    userId: string,
    local: ThemePreferences,
  ): ThemePreferences {
    return db.transaction((tx) => {
      const merged = mergeColorThemes(read(tx, userId), local);
      write(tx, userId, merged);
      return merged;
    });
  },
} as const;
