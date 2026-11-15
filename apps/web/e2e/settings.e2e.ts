import { randomUUID } from "node:crypto";
import { expect } from "@playwright/test";
import { client, createFolder, test } from "./helpers";

test("settings replaces the drive shell and keeps its sections independently navigable", async ({
  page,
  isMobile,
}, testInfo) => {
  await page.goto("/settings");
  await expect(page).toHaveURL("/settings/appearance");
  await expect(
    page.getByRole("heading", { name: "Appearance", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByLabel("Current password", { exact: true }),
  ).toHaveCount(0);
  await expect(page.getByLabel("Device name", { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("combobox", { name: "Search files", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "New file or folder", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("region", { name: "Storage usage", exact: true }),
  ).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath("settings-appearance.png"),
    animations: "disabled",
  });

  for (const [name, href] of [
    ["Account", "/settings/account"],
    ["WebDAV", "/settings/webdav"],
    ["Users & groups", "/settings/admin"],
    ["Appearance", "/settings/appearance"],
  ]) {
    if (isMobile)
      await page
        .getByRole("button", { name: "Toggle Sidebar", exact: true })
        .click();
    const nav = page.getByRole("navigation", { name: "Settings", exact: true });
    const link = nav.getByRole("link", { name, exact: true });
    await link.focus();
    await link.press("Enter");
    await expect(page).toHaveURL(href);
    await expect(
      page.getByRole("heading", { name, exact: true, level: 1 }),
    ).toBeVisible();
    await expect(
      page.getByRole("navigation", {
        name: "Settings breadcrumb",
        exact: true,
      }),
    ).toContainText(name);
    if (isMobile)
      await expect(
        page.getByRole("dialog", { name: "Sidebar", exact: true }),
      ).toBeHidden();
    else await expect(link).toHaveAttribute("aria-current", "page");
    await page.reload();
    await expect(
      page.getByRole("heading", { name, exact: true, level: 1 }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  }
  if (isMobile)
    await page
      .getByRole("button", { name: "Toggle Sidebar", exact: true })
      .click();
  await page.screenshot({
    path: testInfo.outputPath("settings-navigation.png"),
    animations: "disabled",
  });
  await page.getByRole("link", { name: "Back to files", exact: true }).click();
  await expect(page).toHaveURL("/");
  await expect(
    page.getByRole("combobox", { name: "Search files", exact: true }),
  ).toBeVisible();
});

test("direct settings links require sign-in", async ({ browser }) => {
  const context = await browser.newContext({
    storageState: { cookies: [], origins: [] },
  });
  try {
    const page = await context.newPage();
    await page.goto("/settings/account");
    await expect(page).toHaveURL("/login");
    await expect(
      page.getByRole("button", { name: "Sign in", exact: true }),
    ).toBeVisible();
  } finally {
    await context.close();
  }
});

test("queued uploads keep their destination while visiting settings", async ({
  page,
  context,
  isMobile,
}) => {
  const folder = `settings-upload-${randomUUID()}`;
  const rpc = await client(context);
  await page.goto("/");
  await createFolder(page, folder, isMobile);
  await page.getByRole("link", { name: folder, exact: true }).click();
  await expect(page).toHaveURL(`/browse/${folder}`);
  const started = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  await page.route("**/api/upload**", async (route) => {
    // Small uploads send their bytes with the creation POST; larger ones use PATCH.
    if (["POST", "PATCH"].includes(route.request().method())) {
      started.resolve();
      await resume.promise;
    }
    await route.continue();
  });
  const files = ["first.txt", "second.txt"];
  try {
    await page.locator('input[type="file"]').setInputFiles(
      files.map((name) => ({
        name,
        mimeType: "text/plain",
        buffer: Buffer.from(`Contents of ${name}`),
      })),
    );
    await started.promise;
    if (isMobile)
      await page
        .getByRole("button", { name: "Toggle Sidebar", exact: true })
        .click();
    await page.getByRole("link", { name: "Settings", exact: true }).click();
    await expect(page).toHaveURL("/settings/appearance");
    await expect(
      page.getByRole("button", { name: "Cancel upload", exact: true }),
    ).toBeVisible();
    resume.resolve();
    await expect
      .poll(async () =>
        (await rpc.files.list.query({ path: folder }))
          .map((file) => file.name)
          .sort(),
      )
      .toEqual(files);
    await expect(
      page.getByRole("button", { name: "Cancel upload", exact: true }),
    ).toHaveCount(0);
    for (const name of files) {
      const response = await context.request.get(
        `/api/files/download?path=${encodeURIComponent(`${folder}/${name}`)}`,
      );
      expect(response.status()).toBe(200);
      expect(await response.text()).toBe(`Contents of ${name}`);
    }
  } finally {
    resume.resolve();
  }
});
