/**
 * A file icon theme as Nimbus serves it: VS Code's associations from names to icons, compiled
 * on the server from the theme's JSON. Each association holds an index into `icons`, whose
 * entries are content-hashed file names served beside the manifest, so every icon URL is
 * immutable. Only what a file list needs is kept: no expanded or root folder variants.
 *
 * File pages parse it, so it is checked by hand rather than with a schema library: a manifest
 * is thousands of entries, and the validator would otherwise ship with every file page.
 */
export type IconTables = {
  file?: number;
  folder?: number;
  fileNames: Record<string, number>;
  fileExtensions: Record<string, number>;
  languageIds: Record<string, number>;
  folderNames: Record<string, number>;
};

export type IconManifest = {
  version: 1;
  icons: string[];
  base: IconTables;
  /** VS Code's `light` overrides, which apply over `base` in the light scheme. */
  light?: IconTables;
};

export const maxManifestIcons = 20_000;
const maxEntries = 50_000;
const iconName = /^[a-f0-9]{32}\.(svg|png)$/;
const tableNames = [
  "fileNames",
  "fileExtensions",
  "languageIds",
  "folderNames",
] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Checks `value` as tables pointing into `icons` icons; counts its entries into `seen`. */
function parseTables(
  value: unknown,
  icons: number,
  seen: { entries: number },
): IconTables | null {
  if (!isRecord(value)) return null;
  const index = (icon: unknown): icon is number =>
    typeof icon === "number" &&
    Number.isInteger(icon) &&
    icon >= 0 &&
    icon < icons;
  const single = (key: "file" | "folder") => {
    const icon = value[key];
    return icon === undefined || index(icon);
  };
  if (!single("file") || !single("folder")) return null;
  const tables: IconTables = {
    fileNames: {},
    fileExtensions: {},
    languageIds: {},
    folderNames: {},
  };
  if (typeof value.file === "number") tables.file = value.file;
  if (typeof value.folder === "number") tables.folder = value.folder;
  for (const name of tableNames) {
    const table = value[name];
    if (!isRecord(table)) return null;
    const entries = Object.entries(table);
    seen.entries += entries.length;
    if (seen.entries > maxEntries) return null;
    for (const [key, icon] of entries) {
      if (key.length > 256 || !index(icon)) return null;
      tables[name][key] = icon;
    }
  }
  return tables;
}

/** The manifest in `value`, or null when it is not one. */
function parse(value: unknown): IconManifest | null {
  if (!isRecord(value) || value.version !== 1) return null;
  const { icons } = value;
  if (
    !Array.isArray(icons) ||
    icons.length > maxManifestIcons ||
    !icons.every((icon) => typeof icon === "string" && iconName.test(icon))
  )
    return null;
  const names: string[] = icons.filter((icon) => typeof icon === "string");
  const seen = { entries: 0 };
  const base = parseTables(value.base, names.length, seen);
  if (!base) return null;
  if (value.light === undefined) return { version: 1, icons: names, base };
  const light = parseTables(value.light, names.length, seen);
  return light ? { version: 1, icons: names, base, light } : null;
}

export const IconManifest = { parse } as const;
