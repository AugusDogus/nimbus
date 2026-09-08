import { expect } from "@playwright/test";
import { strToU8, zipSync } from "fflate";
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
  await page.goto("/settings");
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
  await page.goto("/settings");
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
  await page.goto("/settings");
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
