import { defaultIconTheme } from "@/lib/icon-themes";
import type { IconChoice } from "@/lib/icon-choice";
import {
  BuiltInIconThemeSources,
  isThemedBuiltIn,
} from "./built-in-icon-themes";
import { IconThemeFiles } from "./icon-theme-files";

/**
 * The icon sets an account can use and the one it chose. Built-in sets are shared by every
 * account; the server answers with the URL of the chosen set's manifest.
 */
const manifestUrl = (theme: string, manifest: string) =>
  `/api/icon-themes/${encodeURIComponent(theme)}/${manifest}`;

/** The directory of `theme` when the account may read it and it is on the server. */
async function directory(
  _userId: string,
  theme: string,
): Promise<string | null> {
  if (isThemedBuiltIn(theme)) {
    const found = await BuiltInIconThemeSources.directory(theme, {
      install: false,
    });
    return found.ok ? found.value : null;
  }
  return null;
}

/** What `theme` resolves to for the browser, or null when it is not on the server. */
async function choice(
  userId: string,
  theme: string,
): Promise<IconChoice | null> {
  if (theme === "lucide") return { id: theme, manifest: null };
  const found = await directory(userId, theme);
  const manifest = found ? await IconThemeFiles.manifest(found) : null;
  return manifest
    ? { id: theme, manifest: manifestUrl(theme, manifest) }
    : null;
}

/** The account's icon set. A set that is gone falls back to the default, then to Lucide. */
async function current(userId: string): Promise<IconChoice> {
  return (
    (await choice(userId, defaultIconTheme)) ?? { id: "lucide", manifest: null }
  );
}

export const IconThemeLibrary = { directory, current } as const;
