import { parse, type ParseError } from "jsonc-parser";
import { unzipSync } from "fflate";
import * as z from "zod/mini";
import { VsCodeTheme, type ThemeResult } from "./vscode-theme";

export const maxExtensionBytes = 20 * 1024 * 1024;
const maxJsonBytes = 1024 * 1024;
const themeFileSchema = z.object({
  include: z.optional(z.string().check(z.maxLength(1024))),
  colors: z.optional(z.record(z.string(), z.unknown())),
});
const manifestSchema = z.object({
  contributes: z.object({
    themes: z
      .array(
        z.object({
          label: z.optional(z.string().check(z.maxLength(200))),
          path: z.string().check(z.maxLength(1024)),
          uiTheme: z.enum(["vs", "vs-dark", "hc-black", "hc-light"]),
        }),
      )
      .check(z.minLength(1), z.maxLength(40)),
  }),
});

function json(source: Uint8Array): unknown {
  const errors: ParseError[] = [];
  const value: unknown = parse(
    new TextDecoder().decode(source).replace(/^\uFEFF/, ""),
    errors,
    { allowTrailingComma: true },
  );
  if (errors.length) throw new Error("A theme file contains invalid JSON.");
  return value;
}

// These are in-memory archive paths, never filesystem paths or fetch URLs.
function resolvePath(path: string, from = "extension/package.json"): string {
  if (path.length > 1024 || /[\0:\\]/.test(path) || path.startsWith("/"))
    throw new Error("A theme contains an invalid include path.");
  const segments = from.split("/").slice(0, -1);
  for (const part of path.split("/")) {
    if (part === "." || part === "") continue;
    if (part === "..") {
      if (segments.length <= 1)
        throw new Error("A theme include points outside the extension.");
      segments.pop();
    } else segments.push(part);
  }
  return segments.join("/");
}

function read(bytes: Uint8Array): ThemeResult<VsCodeTheme[]> {
  if (bytes.byteLength > maxExtensionBytes)
    return {
      ok: false,
      error:
        "This theme extension is larger than 20 MB. Import a theme JSON file instead.",
    };
  try {
    let entries = 0;
    let expandedBytes = 0;
    const extracted = unzipSync(bytes, {
      filter: (entry) => {
        entries += 1;
        if (entries > 2000)
          throw new Error("The extension contains too many files.");
        if (
          !entry.name.startsWith("extension/") ||
          !/\.jsonc?$/i.test(entry.name)
        )
          return false;
        // The sizes come from the archive itself. fflate copies a stored entry's `size` bytes
        // and inflates into a buffer of `originalSize`, so both count. Entries may share one
        // payload; counting every entry's bytes bounds that too.
        if (entry.compression === 0 && entry.size !== entry.originalSize)
          throw new Error("The extension archive is damaged.");
        const bytes = Math.max(entry.size, entry.originalSize);
        expandedBytes += bytes;
        if (bytes > maxJsonBytes || expandedBytes > 8 * maxJsonBytes)
          throw new Error(
            "The extension’s theme files exceed the import size limit.",
          );
        return true;
      },
    });
    const files = new Map(Object.entries(extracted));
    const manifestBytes = files.get("extension/package.json");
    if (!manifestBytes)
      throw new Error("The extension is missing its package.json manifest.");
    const manifest = manifestSchema.safeParse(json(manifestBytes));
    if (!manifest.success)
      throw new Error(
        "This extension does not contain a supported collection of color themes.",
      );
    const resolveColors = (
      path: string,
      chain: string[] = [],
    ): Record<string, unknown> => {
      if (chain.includes(path) || chain.length >= 8)
        throw new Error("A theme has circular or excessively nested includes.");
      const source = files.get(path);
      if (!source)
        throw new Error(`The extension is missing the theme file ${path}.`);
      const theme = themeFileSchema.safeParse(json(source));
      if (!theme.success)
        throw new Error(
          `The theme file ${path} has invalid colors or includes.`,
        );
      const inherited = theme.data.include
        ? resolveColors(resolvePath(theme.data.include, path), [...chain, path])
        : {};
      return { ...inherited, ...theme.data.colors };
    };
    const themes: VsCodeTheme[] = [];
    for (const contribution of manifest.data.contributes.themes) {
      const path = resolvePath(contribution.path);
      const result = VsCodeTheme.fromObject(
        {
          name: contribution.label,
          type:
            contribution.uiTheme === "vs"
              ? "light"
              : contribution.uiTheme === "vs-dark"
                ? "dark"
                : contribution.uiTheme,
          colors: resolveColors(path),
        },
        path.split("/").at(-1),
      );
      if (!result.ok)
        return {
          ok: false,
          error: `${contribution.label ?? contribution.path}: ${result.error}`,
        };
      themes.push(result.value);
    }
    return { ok: true, value: themes };
  } catch (cause) {
    return {
      ok: false,
      error: `${cause instanceof Error ? cause.message : "The extension archive could not be read."} No themes were installed. Try importing a complete theme JSON file instead.`,
    };
  }
}

export const ThemeExtension = { read } as const;
