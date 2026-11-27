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

/** Opens Settings → Appearance from the sidebar, inside the running app. */
async function openSettings(page: Page, mobile: boolean) {
  if (mobile)
    await page
      .getByRole("button", { name: "Toggle Sidebar", exact: true })
      .click();
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await expect(page).toHaveURL("/settings/appearance");
}

/** Chooses a set in Settings → Appearance and waits for the server to take it. */
async function chooseSet(page: Page, name: string) {
  const card = page.getByRole("button", {
    name: `Use ${name} file icons`,
    exact: true,
  });
  await card.click();
  await expect(card).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("alert")).toHaveCount(0);
}

test("switching sets changes icons without a reload, and follows the account to another browser", async ({
  page,
  browser,
  isMobile,
}) => {
  const folder = await sampleFolder(page);
  await chooseView(page, "List view", isMobile);
  await themeIcon(page, "index.ts", "material");
  // A full load would drop this; the app's own navigation keeps it.
  await page.evaluate(() => Object.assign(window, { iconsSamePage: true }));
  const samePage = () =>
    page.evaluate(() => Reflect.get(window, "iconsSamePage") === true);
  try {
    await openSettings(page, isMobile);
    await chooseSet(page, "Lucide");
    await page.goBack();
    await expect(entry(page, "index.ts").locator("img")).toHaveCount(0);
    await expect(entry(page, "index.ts").locator("svg")).toBeVisible();
    await expect(entry(page, "src").locator("img")).toHaveCount(0);
    expect(await samePage()).toBe(true);

    // Another browser signed in to the same account draws the same set.
    const other = await browser.newContext({
      storageState: await page.context().storageState(),
    });
    try {
      const second = await other.newPage();
      await second.goto(`/browse/${folder}`);
      await expect(entry(second, "index.ts")).toBeVisible();
      await expect(entry(second, "index.ts").locator("svg")).toBeVisible();
      await expect(entry(second, "index.ts").locator("img")).toHaveCount(0);
    } finally {
      await other.close();
    }

    await openSettings(page, isMobile);
    await chooseSet(page, "Material+");
    await page.goBack();
    await themeIcon(page, "index.ts", "material");
    expect(await samePage()).toBe(true);
  } finally {
    // Tests share the account: leave it on the default set.
    await page.goto("/settings/appearance");
    await chooseSet(page, "Material+");
  }
});

test("imports an icon set from Open VSX, serves it safely, and removes it", async ({
  page,
  playwright,
  isMobile,
}) => {
  const folder = await sampleFolder(page);
  await page.goto("/settings/appearance");
  await page.getByRole("button", { name: "Add icon set", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "Add icon set",
    exact: true,
  });
  await dialog.getByLabel("Search icon themes").fill("icons");
  await dialog.getByRole("button", { name: "Search", exact: true }).click();
  const results = dialog.getByRole("list", { name: "Icon themes on Open VSX" });
  await expect(results.getByRole("listitem")).toHaveCount(2);
  // A color theme is not offered here.
  await expect(results.getByText("Paper Colors")).toHaveCount(0);

  await dialog
    .getByRole("button", { name: "Add Glyph Icons", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toContainText(
    "draws its icons with a font",
  );

  await dialog
    .getByRole("button", { name: "Add Pixel Icons", exact: true })
    .click();
  await expect(dialog.getByRole("status")).toHaveText("Added Pixel Icons.");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  try {
    await chooseSet(page, "Pixel Icons");
    await page.goto(`/browse/${folder}`);
    await chooseView(page, "List view", isMobile);
    const image = entry(page, "index.ts").locator("img");
    await expect(image).toHaveAttribute(
      "src",
      /^\/api\/icon-themes\/[0-9a-f-]{36}\/[a-f0-9]{32}\.svg$/,
    );
    // The set's generic page is not specific: Nimbus's own icon stands in.
    await expect(entry(page, "notes.xyz").locator("svg text")).toHaveText(
      "XYZ",
    );
    await expect(entry(page, "src").locator("img")).toHaveCount(1);

    const src = (await image.getAttribute("src")) ?? "";
    const response = await page.request.get(src);
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toBe("image/svg+xml");
    expect(response.headers()["x-content-type-options"]).toBe("nosniff");
    expect(response.headers()["content-security-policy"]).toBe(
      "sandbox; default-src 'none'",
    );
    expect(response.headers()["cache-control"]).toContain("immutable");
    // Nobody signed out can read it.
    const anonymous = await playwright.request.newContext({
      baseURL: page.url(),
      storageState: { cookies: [], origins: [] },
    });
    try {
      expect((await anonymous.get(src)).status()).toBe(401);
    } finally {
      await anonymous.dispose();
    }
  } finally {
    await page.goto("/settings/appearance");
    await page
      .getByRole("button", { name: "Remove Pixel Icons", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Remove icon set", exact: true })
      .click();
    await expect(
      page.getByRole("button", {
        name: "Use Pixel Icons file icons",
        exact: true,
      }),
    ).toHaveCount(0);
  }
  // Removing the set in use returns the account to the default set.
  await expect(
    page.getByRole("button", { name: "Use Material+ file icons", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
});
