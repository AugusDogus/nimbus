import { randomUUID } from "node:crypto";
import { expect, type Page } from "@playwright/test";
import { chooseView, client, test, whenCanCreate } from "./helpers";

/** A folder of its own with a few typed files and a `src` folder, opened in the browser. */
async function sampleFolder(page: Page) {
  const rpc = await client(page.context());
  const folder = `icons-${randomUUID().slice(0, 8)}`;
  await rpc.files.createFolder.mutate({ name: folder });
  await rpc.files.createFolder.mutate({ path: folder, name: "src" });
  await page.goto(`/browse/${folder}`);
  await whenCanCreate(page);
  await page.locator('input[type="file"]').setInputFiles(
    ["index.ts", "package.json", "notes.xyz"].map((name) => ({
      name,
      mimeType: "text/plain",
      buffer: Buffer.from(`sample ${name}`),
    })),
  );
  for (const name of ["index.ts", "package.json", "notes.xyz"])
    await expect(entry(page, name)).toBeVisible();
  return folder;
}

const entry = (page: Page, name: string) =>
  page.locator(`[data-entry-name="${name}"]`).filter({ visible: true });

/** The theme icon an entry shows, which must have loaded. */
async function themeIcon(page: Page, name: string, theme: string) {
  const image = entry(page, name).locator("img");
  await expect(image).toHaveAttribute(
    "src",
    new RegExp(`^/api/icon-themes/${theme}/[a-f0-9]{32}\\.svg$`),
  );
  await expect
    .poll(() =>
      image.evaluate((element: HTMLImageElement) => element.naturalWidth),
    )
    .toBeGreaterThan(0);
  await expect(image).toHaveAttribute("alt", "");
  return image.getAttribute("src");
}

test("the default set draws Material icons in list and grid views", async ({
  page,
  isMobile,
}) => {
  await sampleFolder(page);
  await chooseView(page, "List view", isMobile);
  const typescript = await themeIcon(page, "index.ts", "material");
  const json = await themeIcon(page, "package.json", "material");
  expect(typescript).not.toBe(json);
  await themeIcon(page, "src", "material");
  // Material has nothing more specific than its generic page for this type: Nimbus letters it.
  await expect(entry(page, "notes.xyz").locator("img")).toHaveCount(0);
  await expect(entry(page, "notes.xyz").locator("svg text")).toHaveText("XYZ");

  await chooseView(page, "Grid view", isMobile);
  expect(await themeIcon(page, "index.ts", "material")).toBe(typescript);
  await themeIcon(page, "src", "material");
  await expect(entry(page, "notes.xyz").locator("svg text")).toHaveText("XYZ");
});
