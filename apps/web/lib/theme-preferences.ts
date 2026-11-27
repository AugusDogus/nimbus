import * as z from "zod/mini";
import { BuiltInThemes } from "./built-in-themes";
import {
  importedThemeSchema,
  type ThemeResult,
  type VsCodeTheme,
} from "./vscode-theme";

export const themeStorageKey = "nimbus-themes-v1";
/** The account whose server copy `themeStorageKey` mirrors; absent before themes synced. */
export const themeOwnerStorageKey = "nimbus-themes-owner";
export const themeStyleId = "nimbus-custom-themes";
const schema = z
  .object({
    version: z.literal(1),
    themes: z.array(importedThemeSchema).check(z.maxLength(100)),
    light: z.nullable(z.string()),
    dark: z.nullable(z.string()),
  })
  .check(
    z.superRefine((value, context) => {
      if (
        new Set(
          [...BuiltInThemes.all, ...value.themes].map((theme) => theme.id),
        ).size !==
        value.themes.length + BuiltInThemes.all.length
      ) {
        context.addIssue({ code: "custom", message: "Duplicate theme IDs" });
      }
      for (const mode of ["light", "dark"] as const) {
        if (
          value[mode] !== null &&
          ![...BuiltInThemes.all, ...value.themes].some(
            (theme) => theme.id === value[mode] && theme.appearance === mode,
          )
        ) {
          context.addIssue({
            code: "custom",
            message: "Selected theme is missing or has the wrong appearance",
          });
        }
      }
    }),
  );

export type ThemePreferences = z.infer<typeof schema>;
const empty: ThemePreferences = {
  version: 1,
  themes: [],
  light: null,
  dark: null,
};

function parse(raw: string | null): ThemeResult<ThemePreferences> {
  if (raw === null) return { ok: true, value: empty };
  try {
    const value: unknown = JSON.parse(raw);
    const result = schema.safeParse(value);
    if (result.success) return { ok: true, value: result.data };
  } catch {
    /* Report corrupt storage without overwriting it. */
  }
  return {
    ok: false,
    error:
      "Saved themes could not be read. Reload Nimbus or reset saved themes in Appearance. The stored data has not been overwritten.",
  };
}

function install(
  current: ThemePreferences,
  themes: VsCodeTheme[],
): ThemeResult<ThemePreferences> {
  // Re-imports get separate entries, preserving existing user choices.
  const next = { ...current, themes: [...current.themes, ...themes] };
  const result = schema.safeParse(next);
  return result.success
    ? { ok: true, value: result.data }
    : {
        ok: false,
        error:
          "These themes could not be saved. Nimbus supports up to 100 saved themes. Remove an unused theme and try again. Existing themes are unchanged.",
      };
}

function select(
  current: ThemePreferences,
  appearance: "light" | "dark",
  id: string | null,
): ThemePreferences {
  return { ...current, [appearance]: id };
}

function remove(current: ThemePreferences, id: string): ThemePreferences {
  return {
    ...current,
    themes: current.themes.filter((theme) => theme.id !== id),
    light: current.light === id ? null : current.light,
    dark: current.dark === id ? null : current.dark,
  };
}

function resolve(current: ThemePreferences, mode: "light" | "dark") {
  return [...BuiltInThemes.all, ...current.themes].find(
    (entry) => entry.id === current[mode] && entry.appearance === mode,
  );
}

const themeId = z.string().check(z.minLength(1), z.maxLength(200));
/** One change to an account's themes, applied to the server's copy, never a whole replacement. */
const changeSchema = z.discriminatedUnion("kind", [
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
export type ThemeChange = z.infer<typeof changeSchema>;

const invalidSelection: ThemeResult<ThemePreferences> = {
  ok: false,
  error:
    "The theme selection is invalid. Reload and choose an installed theme. Existing themes are unchanged.",
};

/** `change` applied to `current`. Installing selects one variant per appearance it brings. */
function apply(
  current: ThemePreferences,
  change: ThemeChange,
): ThemeResult<ThemePreferences> {
  switch (change.kind) {
    case "install": {
      const installed = install(current, change.themes);
      if (!installed.ok) return installed;
      let next = installed.value;
      for (const mode of ["light", "dark"] as const) {
        const variant = change.themes.find(
          (theme) => theme.appearance === mode,
        );
        if (variant) next = select(next, mode, variant.id);
      }
      return { ok: true, value: next };
    }
    case "select": {
      const result = schema.safeParse(
        select(current, change.appearance, change.id),
      );
      return result.success
        ? { ok: true, value: result.data }
        : invalidSelection;
    }
    case "remove":
      return { ok: true, value: remove(current, change.id) };
    case "reset":
      return { ok: true, value: empty };
  }
}

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
function merge(
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
  const checked = schema.safeParse(merged);
  return checked.success ? checked.data : server;
}

function css(current: ThemePreferences): string {
  return (["light", "dark"] as const)
    .map((mode) => {
      const theme = resolve(current, mode);
      if (!theme) return "";
      return `:root.${mode}{${Object.entries(theme.colors)
        .map(([key, color]) => `--${key}:${color};`)
        .join("")}}`;
    })
    .join("");
}

export const ThemePreferences = {
  empty,
  parse,
  install,
  select,
  remove,
  resolve,
  css,
  schema,
  changeSchema,
  apply,
  merge,
} as const;
