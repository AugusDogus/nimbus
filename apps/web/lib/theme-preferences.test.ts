import { describe, expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { ThemePreferences } from "./theme-preferences";
import { VsCodeTheme } from "./vscode-theme";
import { themeBootScript } from "./theme-boot-script";
import { BuiltInThemes } from "./built-in-themes";
import { importedThemeSchema } from "./vscode-theme";

function imported(name: string, background: string) {
  const result = VsCodeTheme.parse(
    JSON.stringify({ name, colors: { "editor.background": background } }),
  );
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

describe("saved themes", () => {
  test("built-in pairs persist independently and match the pre-paint palette", () => {
    expect(BuiltInThemes.pairs).toHaveLength(5);
    for (const pair of BuiltInThemes.pairs) {
      let preferences = ThemePreferences.empty;
      expect(pair.themes.map((theme) => theme.appearance)).toEqual([
        "light",
        "dark",
      ]);
      for (const theme of pair.themes) {
        expect(importedThemeSchema.safeParse(theme).success).toBe(true);
        preferences = ThemePreferences.select(
          preferences,
          theme.appearance,
          theme.id,
        );
        expect(ThemePreferences.resolve(preferences, theme.appearance)).toEqual(
          theme,
        );
        expect(
          ThemePreferences.parse(
            JSON.stringify({
              ...preferences,
              [theme.appearance === "light" ? "dark" : "light"]: theme.id,
            }),
          ).ok,
        ).toBe(false);
      }
      expect(preferences.themes).toEqual([]);
      expect(ThemePreferences.parse(JSON.stringify(preferences))).toEqual({
        ok: true,
        value: preferences,
      });
      const style = { textContent: "" };
      runInNewContext(themeBootScript, {
        localStorage: { getItem: () => JSON.stringify(preferences) },
        document: { getElementById: () => style },
      });
      expect(style.textContent).toBe(ThemePreferences.css(preferences));
      expect(style.textContent).toContain(":root.light{");
      expect(style.textContent).toContain(":root.dark{");
    }
  });

  test("round trips separate light and dark choices and clears only a removed selection", () => {
    const light = imported("Paper", "#ffffff");
    const dark = imported("Night", "#111111");
    const installed = ThemePreferences.install(ThemePreferences.empty, [
      light,
      dark,
    ]);
    if (!installed.ok) throw new Error(installed.error);
    const preferences = ThemePreferences.select(
      ThemePreferences.select(installed.value, "light", light.id),
      "dark",
      dark.id,
    );
    expect(ThemePreferences.parse(JSON.stringify(preferences))).toEqual({
      ok: true,
      value: preferences,
    });
    expect(ThemePreferences.remove(preferences, dark.id)).toEqual({
      ...preferences,
      dark: null,
      themes: [light],
    });
    expect(ThemePreferences.css(preferences)).toContain(
      ":root.light{--background:#ffffff;",
    );
    expect(ThemePreferences.css(preferences)).toContain(
      ":root.dark{--background:#111111;",
    );
  });

  test("rejects corrupt saved data, invalid colors, wrong modes, and duplicate IDs", () => {
    const dark = imported("Night", "#111111");
    for (const value of [
      { ...ThemePreferences.empty, themes: [dark], light: dark.id },
      { ...ThemePreferences.empty, themes: [dark, dark] },
      { ...ThemePreferences.empty, dark: "missing" },
      {
        ...ThemePreferences.empty,
        themes: [
          {
            ...dark,
            colors: {
              ...dark.colors,
              background: "red; } body { display:none",
            },
          },
        ],
      },
    ])
      expect(ThemePreferences.parse(JSON.stringify(value)).ok).toBe(false);
    expect(ThemePreferences.parse("bad json").ok).toBe(false);
  });

  test("boot palette matches runtime CSS and ignores injected CSS", () => {
    const theme = imported("</script><script>bad()</script>", "#123456");
    const preferences = {
      ...ThemePreferences.empty,
      themes: [theme],
      dark: theme.id,
    };
    const style = { textContent: "" };
    const run = (value: unknown) => {
      runInNewContext(themeBootScript, {
        localStorage: { getItem: () => JSON.stringify(value) },
        document: { getElementById: () => style },
      });
    };
    run(preferences);
    expect(style.textContent).toBe(ThemePreferences.css(preferences));
    run({
      ...preferences,
      themes: [
        {
          ...theme,
          colors: { ...theme.colors, background: "red;}body{display:none" },
        },
      ],
    });
    expect(style.textContent).toBe("");
  });
});

describe("synced themes", () => {
  test("installing selects one variant per appearance it brings", () => {
    const night = imported("Night", "#112233");
    const paper = imported("Paper", "#faf4e8");
    const result = ThemePreferences.apply(ThemePreferences.empty, {
      kind: "install",
      themes: [night, paper],
    });
    if (!result.ok) throw new Error(result.error);
    expect(result.value.dark).toBe(night.id);
    expect(result.value.light).toBe(paper.id);
  });

  test("refuses selecting a theme that is not installed", () => {
    expect(
      ThemePreferences.apply(ThemePreferences.empty, {
        kind: "select",
        appearance: "dark",
        id: "missing",
      }).ok,
    ).toBe(false);
  });

  test("a browser's pre-sync themes become the account's when it has none", () => {
    const night = imported("Night", "#112233");
    const local = {
      ...ThemePreferences.empty,
      themes: [night],
      dark: night.id,
    };
    expect(ThemePreferences.merge(null, local)).toEqual(local);
  });

  test("merging keeps the account's choices, adds new themes once, and fills empty choices", () => {
    const night = imported("Night", "#112233");
    const nightAgain = { ...imported("Night", "#112233"), id: "other-id" };
    const paper = imported("Paper", "#faf4e8");
    const server = {
      ...ThemePreferences.empty,
      themes: [night],
      dark: night.id,
    };
    const local = {
      ...ThemePreferences.empty,
      themes: [nightAgain, paper],
      dark: nightAgain.id,
      light: paper.id,
    };
    const merged = ThemePreferences.merge(server, local);
    expect(merged.themes.map((theme) => theme.name)).toEqual([
      "Night",
      "Paper",
    ]);
    expect(merged.dark).toBe(night.id);
    expect(merged.light).toBe(paper.id);
    // Merging the same browser again changes nothing.
    expect(ThemePreferences.merge(merged, local)).toEqual(merged);
  });
});
