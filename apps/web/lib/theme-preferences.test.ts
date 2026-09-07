import { describe, expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { ThemePreferences } from "./theme-preferences";
import { VsCodeTheme } from "./vscode-theme";
import { themeBootScript } from "../components/theme-boot";

function imported(name: string, background: string) {
  const result = VsCodeTheme.parse(
    JSON.stringify({ name, colors: { "editor.background": background } }),
  );
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

describe("saved themes", () => {
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
    const run = (value: unknown) =>
      runInNewContext(themeBootScript, {
        localStorage: { getItem: () => JSON.stringify(value) },
        document: { getElementById: () => style },
      });
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
