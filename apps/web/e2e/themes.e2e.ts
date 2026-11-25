import { expect } from "@playwright/test";
import { strToU8, zipSync } from "fflate";
import builtInThemes from "../lib/built-in-themes.json" with { type: "json" };
import { test } from "./helpers";

const dark = {
  name: "Test Night",
  colors: { "editor.background": "#112233", "sideBar.background": "#102030" },
};
const light = {
  name: "Test Paper",
  colors: { "editor.background": "#faf4e8" },
};

test("imports themes, preserves System mode, restores on reload, and removes safely", async ({
  page,
}, testInfo) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/settings/appearance");
  const system = page.getByRole("button", {
    name: "Follow the system appearance",
    exact: true,
  });
  await system.click();
  const files = page.locator('input[aria-label="Import VS Code theme files"]');
  await page.getByRole("button", { name: "Add theme", exact: true }).click();
  const chooser = page.waitForEvent("filechooser");
  await page
    .getByRole("button", { name: "Import VS Code theme", exact: true })
    .click();
  await (
    await chooser
  ).setFiles([
    {
      name: "night.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(dark)),
    },
    {
      name: "paper.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(light)),
    },
  ]);
  await expect(
    page.getByRole("button", {
      name: "Use Test Night for dark mode",
      exact: true,
    }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(system).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("body")).toHaveCSS(
    "background-color",
    "rgb(17, 34, 51)",
  );
  await page.reload();
  await expect(page.locator("body")).toHaveCSS(
    "background-color",
    "rgb(17, 34, 51)",
  );
  await expect(system).toHaveAttribute("aria-pressed", "true");
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("body")).toHaveCSS(
    "background-color",
    "rgb(250, 244, 232)",
  );
  await page
    .getByRole("button", { name: "Use dark mode", exact: true })
    .click();
  await expect(page.locator("body")).toHaveCSS(
    "background-color",
    "rgb(17, 34, 51)",
  );
  await page.getByRole("button", { name: "Add theme", exact: true }).click();
  await files.setInputFiles({
    name: "bad.json",
    mimeType: "application/json",
    buffer: Buffer.from("{broken"),
  });
  const addTheme = page.getByRole("dialog", { name: "Add theme", exact: true });
  await expect(addTheme.getByRole("alert")).toContainText("invalid JSON");
  await addTheme.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.locator("body")).toHaveCSS(
    "background-color",
    "rgb(17, 34, 51)",
  );
  await page.screenshot({
    path: testInfo.outputPath("imported-theme.png"),
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page
    .getByRole("button", { name: "Remove Test Night", exact: true })
    .click();
  await page.getByRole("button", { name: "Remove theme", exact: true }).click();
  await expect(
    page.getByRole("button", {
      name: "Use Test Night for dark mode",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(page.locator("body")).toHaveCSS(
    "background-color",
    "rgb(34, 36, 41)",
  );
  await expect(
    page.getByRole("button", {
      name: "Use Test Paper for light mode",
      exact: true,
    }),
  ).toBeVisible();
});

test("searches Open VSX and imports a collection including inherited colors", async ({
  page,
}) => {
  const url = "https://open-vsx.org/api/example/test/1.0.0/file/test.vsix";
  const bytes = zipSync({
    "extension/package.json": strToU8(
      JSON.stringify({
        contributes: {
          themes: [
            {
              label: "Community Night",
              uiTheme: "vs-dark",
              path: "./themes/night.json",
            },
          ],
        },
      }),
    ),
    "extension/base.json": strToU8(JSON.stringify(dark)),
    "extension/themes/night.json": strToU8(
      '{"include":"../base.json","colors":{"editor.background":"#223344"}}',
    ),
  });
  await page.route("https://open-vsx.org/api/-/search?*", (route) =>
    route.fulfill({
      json: {
        extensions: [
          {
            namespace: "example",
            name: "test",
            displayName: "Test Collection",
            files: { download: url },
          },
        ],
      },
    }),
  );
  await page.route(url, (route) =>
    route.fulfill({
      contentType: "application/octet-stream",
      body: Buffer.from(bytes),
    }),
  );
  await page.goto("/settings/appearance");
  await page
    .getByRole("button", { name: "Use dark mode", exact: true })
    .click();
  await page.getByRole("button", { name: "Add theme", exact: true }).click();
  await page
    .getByLabel("Search themes", { exact: true })
    .fill("Test Collection");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page
    .getByRole("button", { name: "Add Test Collection", exact: true })
    .click();
  await expect(
    page.getByRole("button", {
      name: "Use Community Night for dark mode",
      exact: true,
    }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("body")).toHaveCSS(
    "background-color",
    "rgb(34, 51, 68)",
  );
  await page.reload();
  await expect(page.locator("body")).toHaveCSS(
    "background-color",
    "rgb(34, 51, 68)",
  );
});

test("built-in light and dark palettes remain independent in System mode", async ({
  page,
}, testInfo) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/settings/appearance");
  const system = page.getByRole("button", {
    name: "Follow the system appearance",
    exact: true,
  });
  await system.click();
  const ocean = page.getByRole("button", {
    name: "Use Ocean for dark mode",
    exact: true,
  });
  const grove = page.getByRole("button", {
    name: "Use Grove for light mode",
    exact: true,
  });
  await ocean.click();
  await grove.click();
  await expect(system).toHaveAttribute("aria-pressed", "true");
  await expect(ocean).toHaveAttribute("aria-pressed", "true");
  await expect(grove).toHaveAttribute("aria-pressed", "true");
  const background = await page
    .locator("body")
    .evaluate((body) => getComputedStyle(body).backgroundColor);
  await page.reload();
  await expect(page.locator("body")).toHaveCSS("background-color", background);
  await expect(ocean).toHaveAttribute("aria-pressed", "true");
  await expect(grove).toHaveAttribute("aria-pressed", "true");
  await page.screenshot({
    path: testInfo.outputPath("built-in-themes-dark.png"),
  });
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("body")).not.toHaveCSS(
    "background-color",
    background,
  );
  await page.screenshot({
    path: testInfo.outputPath("built-in-themes-light.png"),
  });
  await page
    .getByRole("button", { name: "Use Nimbus for light mode", exact: true })
    .click();
  await expect(page.locator("body")).toHaveCSS(
    "background-color",
    "rgb(247, 248, 250)",
  );
  await expect(ocean).toHaveAttribute("aria-pressed", "true");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test("pages outside Appearance follow a system color scheme change at once", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/");
  const root = page.locator("html");
  await expect(root).toHaveClass(/\blight\b/);
  // The theme styles load after the page; until then no change is followed.
  await expect(page.locator("#root")).toBeVisible();
  await expect(async () => {
    await page.emulateMedia({ colorScheme: "light" });
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(root).toHaveClass(/\bdark\b/, { timeout: 1_000 });
  }).toPass();
  await page.emulateMedia({ colorScheme: "light" });
  await expect(root).toHaveClass(/\blight\b/);
});

test("primary buttons take the theme's primary colour, and hover and press keep their contrast", async ({
  page,
  isMobile,
}) => {
  const hex = (value: string) => {
    const [r, g, b] = [1, 3, 5].map((at) =>
      Number.parseInt(value.slice(at, at + 2), 16),
    );
    return `rgb(${r}, ${g}, ${b})`;
  };
  const themes = [
    {
      name: "Nimbus",
      light: { primary: "#426699", "primary-foreground": "#ffffff" },
      dark: { primary: "#b8cdf4", "primary-foreground": "#223859" },
    },
    ...builtInThemes,
  ];
  await page.goto("/settings/appearance");
  await page
    .getByRole("button", { name: "Follow the system appearance", exact: true })
    .click();
  for (const theme of themes)
    for (const mode of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: mode });
      await page.goto("/settings/appearance");
      await page
        .getByRole("button", {
          name: `Use ${theme.name} for ${mode} mode`,
          exact: true,
        })
        .click();
      await page.goto("/settings/account");
      const button = page.locator("form button[type=submit]").first();
      await expect(button).toBeVisible();
      const fill = button.locator("> span[aria-hidden]").first();
      const palette = theme[mode];
      await expect(fill, `${theme.name} ${mode}`).toHaveCSS(
        "background-color",
        hex(palette.primary),
      );
      await expect(button, `${theme.name} ${mode}`).toHaveCSS(
        "color",
        hex(palette["primary-foreground"]),
      );
      const contrast = () =>
        button.evaluate((element) => {
          const fillElement = element.firstElementChild;
          if (!fillElement) return 0;
          const channels = (color: string) =>
            (color.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
          const luminance = (color: string) => {
            const [r = 0, g = 0, b = 0] = channels(color).map((channel) => {
              const c = channel / 255;
              return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
            });
            return 0.2126 * r + 0.7152 * g + 0.0722 * b;
          };
          // Colours may come back in another space; a canvas turns them into sRGB.
          const srgb = (color: string) => {
            const context = document.createElement("canvas").getContext("2d");
            if (!context) return color;
            context.fillStyle = color;
            context.fillRect(0, 0, 1, 1);
            const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
            return `rgb(${r}, ${g}, ${b})`;
          };
          const one = luminance(
            srgb(getComputedStyle(fillElement).backgroundColor),
          );
          const other = luminance(srgb(getComputedStyle(element).color));
          return (Math.max(one, other) + 0.05) / (Math.min(one, other) + 0.05);
        });
      const rest = await contrast();
      expect(rest, `${theme.name} ${mode} at rest`).toBeGreaterThanOrEqual(4.5);
      // Touch screens have no hover.
      if (isMobile) continue;
      await button.hover();
      // Hover moves the fill away from the label's colour.
      await expect
        .poll(contrast, { message: `${theme.name} ${mode} on hover` })
        .toBeGreaterThan(rest);
      const hovered = await contrast();
      // Pressing moves it further; leaving before letting go submits nothing.
      await page.mouse.down();
      await expect
        .poll(contrast, { message: `${theme.name} ${mode} pressed` })
        .toBeGreaterThan(hovered);
      await page.mouse.move(0, 0);
      await page.mouse.up();
    }
});
