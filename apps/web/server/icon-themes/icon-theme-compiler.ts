import { createHash } from "node:crypto";
import { parse, type ParseError } from "jsonc-parser";
import * as z from "zod/mini";
import {
  IconManifest,
  maxManifestIcons,
  type IconTables,
} from "@/lib/icon-manifest";
import type { IconThemeArchive } from "./icon-theme-archive";

/**
 * Turns a VS Code file icon theme into the manifest Nimbus serves and the icons beside it,
 * keyed by content hash. Only SVG and PNG icons are accepted; font-based themes (Seti-style
 * `fonts` and `fontCharacter`) are refused with a message saying so.
 */
export type CompiledIconTheme = {
  manifest: IconManifest;
  /** Served file name (`<hash>.<svg|png>`) to its bytes. */
  icons: Map<string, Uint8Array>;
  /** The licence text shipped beside the extension's manifest, if any. */
  licence: string | null;
  /** The icons' total size. */
  bytes: number;
};

export type IconThemeContribution = { id: string; label: string; path: string };
export type ExtensionIconThemes = {
  displayName: string | null;
  licence: string | null;
  themes: IconThemeContribution[];
};
export type CompileResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

const maxIconBytes = 1024 * 1024;
const maxThemeJsonBytes = 4 * 1024 * 1024;
const name = z.string().check(z.maxLength(256));
const associations = z.optional(
  z.record(name, z.string().check(z.maxLength(256))),
);
const tablesSchema = z.object({
  file: z.optional(z.string()),
  folder: z.optional(z.string()),
  fileNames: associations,
  fileExtensions: associations,
  languageIds: associations,
  folderNames: associations,
});
const themeSchema = z.extend(tablesSchema, {
  iconDefinitions: z.record(
    z.string().check(z.maxLength(256)),
    z.object({
      iconPath: z.optional(z.string().check(z.maxLength(1024))),
      fontCharacter: z.optional(z.string()),
    }),
  ),
  fonts: z.optional(z.array(z.unknown())),
  light: z.optional(tablesSchema),
});
const packageSchema = z.object({
  displayName: z.optional(z.string().check(z.maxLength(200))),
  license: z.optional(z.string().check(z.maxLength(200))),
  contributes: z.optional(
    z.object({
      iconThemes: z.optional(
        z
          .array(
            z.object({
              id: z.string().check(z.minLength(1), z.maxLength(200)),
              label: z.optional(z.string().check(z.maxLength(200))),
              path: z.string().check(z.minLength(1), z.maxLength(1024)),
            }),
          )
          .check(z.maxLength(40)),
      ),
    }),
  ),
});

const fail = <T>(error: string): CompileResult<T> => ({ ok: false, error });

function json(bytes: Uint8Array): unknown {
  const errors: ParseError[] = [];
  const value: unknown = parse(
    new TextDecoder().decode(bytes).replace(/^﻿/, ""),
    errors,
    { allowTrailingComma: true },
  );
  return errors.length ? undefined : value;
}

/** `relative` from the file at `from`, both archive paths; null when it leaves `extension/`. */
export function archivePath(relative: string, from: string): string | null {
  if (
    /[\0\\]/.test(relative) ||
    relative.startsWith("/") ||
    /^[a-z]:/i.test(relative)
  )
    return null;
  const segments = from.split("/").slice(0, -1);
  for (const part of relative.split("/")) {
    if (part === "." || part === "") continue;
    if (part === "..") {
      if (segments.length <= 1) return null;
      segments.pop();
    } else segments.push(part);
  }
  const path = segments.join("/");
  return path.startsWith("extension/") ? path : null;
}

const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** The icon's type when its bytes are what its name says, otherwise null. */
export function iconType(
  path: string,
  bytes: Uint8Array,
): "svg" | "png" | null {
  if (/\.png$/i.test(path))
    return pngSignature.every((byte, index) => bytes[index] === byte)
      ? "png"
      : null;
  if (!/\.svg$/i.test(path)) return null;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  const start = text.replace(/^﻿/, "").trimStart();
  return start.startsWith("<") && /<svg[\s>/]/i.test(start.slice(0, 4096))
    ? "svg"
    : null;
}

function licenceText(files: IconThemeArchive): string | null {
  for (const [path, bytes] of files)
    if (
      /^extension\/licen[cs]e(\.(txt|md))?$/i.test(path) &&
      bytes.byteLength <= 64 * 1024
    )
      return new TextDecoder().decode(bytes);
  return null;
}

/** The icon themes an extension's package.json contributes. */
function contributions(
  files: IconThemeArchive,
): CompileResult<ExtensionIconThemes> {
  const source = files.get("extension/package.json");
  if (!source)
    return fail("The extension is missing its package.json manifest.");
  const parsed = packageSchema.safeParse(json(source));
  if (!parsed.success)
    return fail("The extension's package.json manifest could not be read.");
  const themes = parsed.data.contributes?.iconThemes ?? [];
  if (themes.length === 0)
    return fail(
      "This extension contributes no file icon themes. It may be a color theme: add it under Themes instead.",
    );
  return {
    ok: true,
    value: {
      displayName: parsed.data.displayName ?? null,
      licence: parsed.data.license ?? null,
      themes: themes.map((theme) => ({
        id: theme.id,
        label: theme.label ?? theme.id,
        path: theme.path,
      })),
    },
  };
}

type Icons = {
  names: string[];
  bytes: Map<string, Uint8Array>;
  byHash: Map<string, number>;
  total: number;
};

/**
 * One theme's tables, with each definition resolved to a served icon. A definition whose file
 * is missing is left out, as VS Code shows nothing for it; a file of the wrong type refuses the
 * whole theme.
 */
function compileTheme(
  files: IconThemeArchive,
  path: string,
  icons: Icons,
): CompileResult<{ base: IconTables; light: IconTables | undefined }> {
  const source = files.get(path);
  if (!source)
    return fail(
      `The extension is missing its icon theme file ${path.slice(10)}.`,
    );
  if (source.byteLength > maxThemeJsonBytes)
    return fail(`The icon theme file ${path.slice(10)} is larger than 4 MB.`);
  const parsed = themeSchema.safeParse(json(source));
  if (!parsed.success)
    return fail(
      `The icon theme file ${path.slice(10)} is not a valid VS Code file icon theme.`,
    );
  const theme = parsed.data;
  const definitions = Object.entries(theme.iconDefinitions);
  if (
    (theme.fonts?.length ?? 0) > 0 ||
    !definitions.some(([, definition]) => definition.iconPath !== undefined)
  )
    return fail(
      "This icon theme draws its icons with a font (as Seti does). Nimbus supports only themes made of SVG or PNG icons.",
    );
  const resolved = new Map<string, number>();
  for (const [id, definition] of definitions) {
    // An empty path draws nothing in VS Code, as vscode-icons' light placeholders do.
    if (!definition.iconPath) continue;
    const file = archivePath(definition.iconPath, path);
    if (file === null)
      return fail(
        `The icon ${id} points outside the extension, so the theme was refused.`,
      );
    const bytes = files.get(file);
    if (!bytes) {
      if (!/\.(svg|png)$/i.test(file))
        return fail(
          `The icon ${id} is ${file.slice(10)}, which is not an SVG or PNG file. Nimbus supports only SVG and PNG icons.`,
        );
      continue;
    }
    if (bytes.byteLength > maxIconBytes)
      return fail(`The icon ${file.slice(10)} is larger than 1 MB.`);
    const type = iconType(file, bytes);
    if (type === null)
      return fail(
        `The icon ${file.slice(10)} is not a valid ${/\.png$/i.test(file) ? "PNG" : "SVG"} file, so the theme was refused.`,
      );
    const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 32);
    let index = icons.byHash.get(hash);
    if (index === undefined) {
      if (icons.names.length >= maxManifestIcons)
        return fail(`The theme has more than ${maxManifestIcons} icons.`);
      index = icons.names.length;
      const served = `${hash}.${type}`;
      icons.names.push(served);
      icons.bytes.set(served, bytes);
      icons.byHash.set(hash, index);
      icons.total += bytes.byteLength;
    }
    resolved.set(id, index);
  }
  const table = (entries: Record<string, string> | undefined) => {
    const out: Record<string, number> = {};
    for (const [key, id] of Object.entries(entries ?? {})) {
      const icon = resolved.get(id);
      if (icon !== undefined) out[key.toLowerCase()] = icon;
    }
    return out;
  };
  const tables = (part: z.infer<typeof tablesSchema>): IconTables => {
    const file = part.file === undefined ? undefined : resolved.get(part.file);
    const folder =
      part.folder === undefined ? undefined : resolved.get(part.folder);
    return {
      ...(file === undefined ? {} : { file }),
      ...(folder === undefined ? {} : { folder }),
      fileNames: table(part.fileNames),
      fileExtensions: table(part.fileExtensions),
      languageIds: table(part.languageIds),
      folderNames: table(part.folderNames),
    };
  };
  return {
    ok: true,
    value: {
      base: tables(theme),
      light: theme.light ? tables(theme.light) : undefined,
    },
  };
}

/**
 * Compiles the theme at `paths.dark`, an archive path. `paths.light`, when given, names a second
 * theme of the same extension (Catppuccin's Latte beside Mocha) whose whole tables become the
 * light scheme's overrides.
 */
function compile(
  files: IconThemeArchive,
  paths: { dark: string; light?: string },
): CompileResult<CompiledIconTheme> {
  const icons: Icons = {
    names: [],
    bytes: new Map(),
    byHash: new Map(),
    total: 0,
  };
  const dark = compileTheme(files, paths.dark, icons);
  if (!dark.ok) return dark;
  let light = dark.value.light;
  if (paths.light !== undefined) {
    const paired = compileTheme(files, paths.light, icons);
    if (!paired.ok) return paired;
    light = paired.value.base;
  }
  const manifest = IconManifest.parse({
    version: 1,
    icons: icons.names,
    base: dark.value.base,
    ...(light ? { light } : {}),
  });
  if (!manifest)
    return fail("The icon theme has more names than Nimbus can serve.");
  return {
    ok: true,
    value: {
      manifest,
      icons: icons.bytes,
      licence: licenceText(files),
      bytes: icons.total,
    },
  };
}

/** The archive path of a contribution's theme file, relative to package.json. */
const themePath = (contribution: IconThemeContribution) =>
  archivePath(contribution.path, "extension/package.json");

export const IconThemeCompiler = { contributions, compile, themePath } as const;
