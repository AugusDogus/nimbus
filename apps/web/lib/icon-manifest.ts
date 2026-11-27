import * as z from "zod/mini";

/**
 * A file icon theme as Nimbus serves it: VS Code's associations from names to icons, compiled
 * on the server from the theme's JSON. Each association holds an index into `icons`, whose
 * entries are content-hashed file names served beside the manifest, so every icon URL is
 * immutable. Only what a file list needs is kept: no expanded or root folder variants.
 */
export const maxManifestIcons = 20_000;
const maxEntries = 50_000;
const index = z
  .number()
  .check(z.int(), z.nonnegative(), z.lt(maxManifestIcons));
const table = z.record(z.string().check(z.maxLength(256)), index);
const tables = z.object({
  file: z.optional(index),
  folder: z.optional(index),
  fileNames: table,
  fileExtensions: table,
  languageIds: table,
  folderNames: table,
});
export type IconTables = z.infer<typeof tables>;

const schema = z
  .object({
    version: z.literal(1),
    icons: z
      .array(z.string().check(z.regex(/^[a-f0-9]{32}\.(svg|png)$/)))
      .check(z.maxLength(maxManifestIcons)),
    base: tables,
    /** VS Code's `light` overrides, which apply over `base` in the light scheme. */
    light: z.optional(tables),
  })
  .check(
    z.superRefine((value, context) => {
      let entries = 0;
      for (const part of [value.base, value.light]) {
        if (!part) continue;
        const all = [
          part.file,
          part.folder,
          ...Object.values(part.fileNames),
          ...Object.values(part.fileExtensions),
          ...Object.values(part.languageIds),
          ...Object.values(part.folderNames),
        ];
        entries += all.length;
        if (
          all.some((icon) => icon !== undefined && icon >= value.icons.length)
        )
          context.addIssue({ code: "custom", message: "Unknown icon index" });
      }
      if (entries > maxEntries)
        context.addIssue({ code: "custom", message: "Too many associations" });
    }),
  );
export type IconManifest = z.infer<typeof schema>;

const emptyTables = (): IconTables => ({
  fileNames: {},
  fileExtensions: {},
  languageIds: {},
  folderNames: {},
});

export const IconManifest = {
  schema,
  emptyTables,
  /** Parses a manifest fetched from the server; null when it is not one. */
  parse(value: unknown): IconManifest | null {
    const result = schema.safeParse(value);
    return result.success ? result.data : null;
  },
} as const;
