import path from "node:path";
import { and, asc, eq } from "drizzle-orm";
import type { IconChoice } from "@/lib/icon-choice";
import {
  BuiltInIconThemes,
  defaultIconTheme,
  type BuiltInIconTheme,
} from "@/lib/icon-themes";
import { db } from "../db";
import { importedIconTheme, userAppearance } from "../db/schema";
import { getConfigRoot } from "../storage-paths";
import {
  BuiltInIconThemeSources,
  isThemedBuiltIn,
} from "./built-in-icon-themes";
import { IconThemeFiles } from "./icon-theme-files";

/**
 * The icon sets an account can use and the one it chose. Built-in sets are shared by every
 * account; the server answers with the URL of the chosen set's manifest.
 */
const themeUrl = (theme: string, file: string) =>
  `/api/icon-themes/${encodeURIComponent(theme)}/${file}`;

export type IconSetOption = {
  id: string;
  name: string;
  credit: string | null;
  homepage: string | null;
  /** Where to read the set's licence, when it ships one. */
  licence: string | null;
  /** `download`: a built-in set fetched from Open VSX the first time it is chosen. */
  state: "ready" | "download" | "unavailable";
  manifest: string | null;
  /** Why the set cannot be used, when it cannot. */
  problem: string | null;
  /** Imported by this account, which can remove it. */
  imported: boolean;
};

export type LibraryResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

/** Where an imported set's files live. Ids are Nimbus's own UUIDs, never names from the set. */
export const importedDirectory = (id: string) =>
  path.join(getConfigRoot(), "icon-themes", "imported", id);

const importedRow = async (userId: string, theme: string) =>
  (
    await db
      .select()
      .from(importedIconTheme)
      .where(
        and(
          eq(importedIconTheme.id, theme),
          eq(importedIconTheme.userId, userId),
        ),
      )
  )[0];

/** The directory of `theme` when the account may read it and it is on the server. */
async function directory(
  userId: string,
  theme: string,
): Promise<string | null> {
  if (isThemedBuiltIn(theme)) {
    const found = await BuiltInIconThemeSources.directory(theme, {
      install: false,
    });
    return found.ok ? found.value : null;
  }
  const row = await importedRow(userId, theme);
  return row ? importedDirectory(row.id) : null;
}

async function served(theme: string, folder: string) {
  const manifest = await IconThemeFiles.manifest(folder);
  if (!manifest) return null;
  const licence = await Bun.file(path.join(folder, "LICENSE.txt")).exists();
  return {
    manifest: themeUrl(theme, manifest),
    licence: licence ? themeUrl(theme, "LICENSE.txt") : null,
  };
}

/** What `theme` resolves to for the browser, or null when it is not on the server. */
async function choice(
  userId: string,
  theme: string,
): Promise<IconChoice | null> {
  if (theme === "lucide") return { id: theme, manifest: null };
  const found = await directory(userId, theme);
  const files = found ? await served(theme, found) : null;
  return files ? { id: theme, manifest: files.manifest } : null;
}

async function chosen(userId: string): Promise<string> {
  const [row] = await db
    .select({ iconTheme: userAppearance.iconTheme })
    .from(userAppearance)
    .where(eq(userAppearance.userId, userId));
  return row?.iconTheme ?? defaultIconTheme;
}

/** The account's icon set. A set that is gone falls back to the default, then to Lucide. */
async function current(userId: string): Promise<IconChoice> {
  return (
    (await choice(userId, await chosen(userId))) ??
    (await choice(userId, defaultIconTheme)) ?? { id: "lucide", manifest: null }
  );
}

async function builtInOption(theme: BuiltInIconTheme): Promise<IconSetOption> {
  const option = {
    id: theme.id,
    name: theme.name,
    credit: theme.credit,
    homepage: theme.homepage,
    imported: false,
  };
  if (!isThemedBuiltIn(theme.id))
    return {
      ...option,
      licence: null,
      state: "ready",
      manifest: null,
      problem: null,
    };
  const found = await BuiltInIconThemeSources.directory(theme.id, {
    install: false,
  });
  const files = found.ok ? await served(theme.id, found.value) : null;
  if (files) return { ...option, ...files, state: "ready", problem: null };
  return {
    ...option,
    licence: null,
    manifest: null,
    state: found.ok || found.error === null ? "download" : "unavailable",
    problem: found.ok ? null : found.error,
  };
}

async function importedOptions(userId: string): Promise<IconSetOption[]> {
  const rows = await db
    .select()
    .from(importedIconTheme)
    .where(eq(importedIconTheme.userId, userId))
    .orderBy(asc(importedIconTheme.createdAt));
  return Promise.all(
    rows.map(async (row): Promise<IconSetOption> => {
      const files = await served(row.id, importedDirectory(row.id));
      return {
        id: row.id,
        name: row.name,
        credit: `${row.extension} on Open VSX${row.licence ? `, ${row.licence} licence` : ""}`,
        homepage: null,
        licence: files?.licence ?? null,
        state: files ? "ready" : "unavailable",
        manifest: files?.manifest ?? null,
        problem: files
          ? null
          : "Its files are missing from the server. Remove it and import it again.",
        imported: true,
      };
    }),
  );
}

/** Every set the account can choose, and which it chose. */
async function list(userId: string) {
  const sets = [
    ...(await Promise.all(BuiltInIconThemes.all.map(builtInOption))),
    ...(await importedOptions(userId)),
  ];
  return { chosen: (await current(userId)).id, sets };
}

/** Removes an imported set and its files. An account using it falls back to the default. */
async function remove(
  userId: string,
  theme: string,
): Promise<LibraryResult<null>> {
  const row = await importedRow(userId, theme);
  if (!row)
    return {
      ok: false,
      error: "This icon set is not one you imported, so it was not removed.",
    };
  await db
    .delete(importedIconTheme)
    .where(
      and(
        eq(importedIconTheme.id, row.id),
        eq(importedIconTheme.userId, userId),
      ),
    );
  await IconThemeFiles.remove(importedDirectory(row.id));
  return { ok: true, value: null };
}

/** Saves the account's set, downloading a built-in set the server does not have yet. */
async function choose(
  userId: string,
  theme: string,
): Promise<LibraryResult<IconChoice>> {
  if (isThemedBuiltIn(theme)) {
    const installed = await BuiltInIconThemeSources.directory(theme, {
      install: true,
    });
    if (!installed.ok)
      return {
        ok: false,
        error:
          installed.error ??
          "This icon set is not on the server. Choose another set.",
      };
  }
  const resolved = await choice(userId, theme);
  if (!resolved)
    return {
      ok: false,
      error:
        "This icon set is no longer on the server. Choose another set. Your current icons are unchanged.",
    };
  await db
    .insert(userAppearance)
    .values({ userId, iconTheme: theme })
    .onConflictDoUpdate({
      target: userAppearance.userId,
      set: { iconTheme: theme, updatedAt: new Date() },
    });
  return { ok: true, value: resolved };
}

export const IconThemeLibrary = {
  directory,
  current,
  list,
  choose,
  remove,
  served,
} as const;
