import { randomUUID } from "node:crypto";
import { expect } from "@playwright/test";
import { client, test } from "./helpers";

test("keeps primary navigation and utility actions usable in both themes", async ({
  page,
  isMobile,
}, testInfo) => {
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Account menu", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: isMobile ? "New file or folder" : "New",
      exact: true,
    }),
  ).toBeEnabled();

  for (const theme of ["Dark", "Light"]) {
    if (isMobile)
      await page
        .getByRole("button", { name: "Toggle Sidebar", exact: true })
        .click();
    const brand = page
      .locator('[data-slot="sidebar-header"]')
      .getByRole("link", { name: "Nimbus home", exact: true });
    await expect(brand).toHaveAttribute("href", "/");
    await expect(brand.locator("svg")).toBeVisible();
    await expect(brand.locator("svg rect")).toHaveCount(0);
    const storage = page.getByRole("region", {
      name: "Storage usage",
      exact: true,
    });
    await expect(
      storage.getByRole("progressbar", {
        name: "Disk storage used",
        exact: true,
      }),
    ).toHaveAttribute("aria-valuenow", /^(?:100|[1-9]?\d)$/);
    await expect(
      storage.getByText("Nimbus files", { exact: true }),
    ).toBeVisible();
    await expect(storage.getByText(/^\d+(?:\.\d+)? [KMGTPE]?B$/)).toBeVisible();
    const create = page.getByRole("button", { name: "New", exact: true });
    await expect(create).toBeEnabled();
    await create.scrollIntoViewIfNeeded();
    const buttonCenter = await create.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      return bounds.x + bounds.width / 2;
    });
    const textCenter = await create
      .getByText("New", { exact: true })
      .evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        return bounds.x + bounds.width / 2;
      });
    expect(Math.abs(textCenter - buttonCenter)).toBeLessThanOrEqual(1);
    await expect(
      page.getByRole("link", { name: "Settings", exact: true }),
    ).toHaveAttribute("href", "/settings");
    await expect(
      page
        .locator('[data-slot="sidebar-footer"]')
        .getByRole("button", { name: "Theme", exact: true }),
    ).toHaveCount(0);
    const settings = page.getByRole("link", { name: "Settings", exact: true });
    await expect(settings).toHaveText("");
    await expect(settings.locator("svg")).toBeVisible();
    await settings.click();
    await expect(page).toHaveURL("/settings/appearance");
    if (isMobile)
      await expect(
        page.getByRole("dialog", { name: "Sidebar", exact: true }),
      ).toBeHidden();
    await expect(
      page.getByRole("heading", { name: "Appearance", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", {
        name: `Use ${theme.toLowerCase()} mode`,
        exact: true,
      })
      .click();
    await expect(page.locator("html")).toHaveClass(theme.toLowerCase());
    await expect(page.getByRole("menu")).toHaveCount(0);
    await page.goto("/");
    await expect(page.locator("html")).toHaveClass(theme.toLowerCase());
    if (isMobile)
      await page
        .getByRole("button", { name: "Toggle Sidebar", exact: true })
        .click();
    expect(
      await brand
        .locator("svg")
        .evaluate(
          (element) =>
            getComputedStyle(element).color ===
            getComputedStyle(document.body).color,
        ),
    ).toBe(true);
    await expect(
      page.getByRole("button", { name: "More", exact: true }),
    ).toHaveCount(0);
    if (isMobile) {
      await expect(
        page.getByRole("dialog", { name: "Sidebar", exact: true }),
      ).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(
        page.getByRole("dialog", { name: "Sidebar", exact: true }),
      ).toBeHidden();
    }
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(
        `nimbus-${isMobile ? "mobile" : "desktop"}-${theme.toLowerCase()}.png`,
      ),
      animations: "disabled",
    });

    const account = page.getByRole("button", {
      name: "Account menu",
      exact: true,
    });
    await account.focus();
    await expect(account).toBeFocused();
    await account.press("Enter");
    await expect(
      page.getByRole("menuitem", { name: "Trash", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("menuitem", { name: "Share links", exact: true }),
    ).toHaveCount(0);
    await expect(page.getByRole("menuitem")).toHaveCount(2);
    for (const [name, href] of [["Administration", "/admin"]]) {
      await expect(
        page.getByRole("menuitem", { name, exact: true }),
      ).toHaveAttribute("href", href);
    }
    await expect(
      page.getByRole("menuitem", { name: "Sign out", exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath(
        `nimbus-${isMobile ? "mobile" : "desktop"}-${theme.toLowerCase()}-account.png`,
      ),
      animations: "disabled",
    });
    await page.keyboard.press("Escape");
    await expect(account).toBeFocused();
    await expect(page.getByRole("menu")).toHaveCount(0);

    if (isMobile)
      await page
        .getByRole("button", { name: "Toggle Sidebar", exact: true })
        .click();
    const primary = page
      .locator('[data-slot="sidebar-content"]')
      .getByRole("link");
    await expect(primary).toHaveCount(5);
    for (const [name, href] of [
      ["My files", "/home"],
      ["My Drive", "/"],
      ["Shared", "/shared"],
      ["Recent", "/recent"],
      ["Starred", "/starred"],
    ]) {
      await expect(primary.filter({ hasText: name })).toHaveAttribute(
        "href",
        href,
      );
    }

    if (isMobile) {
      await page.screenshot({
        path: testInfo.outputPath(
          `nimbus-mobile-${theme.toLowerCase()}-navigation.png`,
        ),
        animations: "disabled",
      });
      await page.keyboard.press("Escape");
      await expect(
        page.getByRole("dialog", { name: "Sidebar", exact: true }),
      ).toBeHidden();
      await page
        .getByRole("button", { name: "Toggle Sidebar", exact: true })
        .click();
      await page
        .getByRole("navigation", { name: "Files", exact: true })
        .getByRole("link", { name: "Shared", exact: true })
        .click();
      await expect(page).toHaveURL("/shared");
      await expect(
        page.getByRole("dialog", { name: "Sidebar", exact: true }),
      ).toBeHidden();
      await page
        .getByRole("button", { name: "Toggle Sidebar", exact: true })
        .click();
    } else {
      await page
        .getByRole("button", { name: "Toggle Sidebar", exact: true })
        .click();
      await expect(create).toBeVisible();
      await create.focus();
      await expect(create).toBeFocused();
      await create.press("Enter");
      await expect(
        page.getByRole("menuitem", { name: "New folder", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("menuitem", { name: "Upload file", exact: true }),
      ).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(create).toBeFocused();
      await expect(page.getByRole("menu")).toHaveCount(0);
      await page.screenshot({
        path: testInfo.outputPath(
          `nimbus-desktop-${theme.toLowerCase()}-collapsed.png`,
        ),
        animations: "disabled",
      });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
      await page
        .getByRole("button", { name: "Toggle Sidebar", exact: true })
        .click();
    }
    await page.getByRole("link", { name: "Settings", exact: true }).click();
    await expect(page).toHaveURL("/settings/appearance");
    await expect(
      page.getByRole("heading", { name: "Appearance", exact: true }),
    ).toBeVisible();
    if (isMobile)
      await expect(
        page.getByRole("dialog", { name: "Sidebar", exact: true }),
      ).toBeHidden();
    await page.goto("/");
  }
});

test("keeps sorting controls and the final row reachable while scrolling", async ({
  page,
  context,
  isMobile,
}, testInfo) => {
  const folder = `scroll-check-${randomUUID()}`;
  const rpc = await client(context);
  await rpc.prefs.set.mutate({
    view: "list",
    sortField: "name",
    sortDirection: "asc",
    groupByType: true,
  });
  await rpc.files.createFolder.mutate({ name: folder });
  for (let index = 0; index < 40; index += 1) {
    await rpc.files.createFolder.mutate({
      path: folder,
      name: `row-${String(index).padStart(2, "0")}`,
    });
  }

  await page.goto(`/browse/${folder}`);
  const last = page.getByRole("link", { name: "row-39", exact: true });
  await expect(last).not.toBeInViewport();
  await page.getByRole("main").hover();
  await page.mouse.wheel(0, 10_000);
  await expect(last).toBeInViewport();
  const sort = isMobile
    ? page.getByRole("button", { name: "Sort and filter options", exact: true })
    : page.getByRole("combobox", { name: "Sort files", exact: true });
  await expect(sort).toBeInViewport({ ratio: 1 });
  await sort.click();
  await page
    .getByRole(isMobile ? "button" : "option", {
      name: "Name (Z to A)",
      exact: true,
    })
    .click();
  await expect(
    page.locator("[data-entry-name]").filter({ visible: true }).first(),
  ).toHaveAttribute("data-entry-name", "row-39");
  await expect
    .poll(async () => (await rpc.prefs.get.query()).sortDirection)
    .toBe("desc");
  await sort.click();
  await page
    .getByRole(isMobile ? "button" : "option", {
      name: "Name (A to Z)",
      exact: true,
    })
    .click();
  await expect(
    page.locator("[data-entry-name]").filter({ visible: true }).first(),
  ).toHaveAttribute("data-entry-name", "row-00");
  await expect
    .poll(async () => (await rpc.prefs.get.query()).sortDirection)
    .toBe("asc");
  await expect(
    page.getByRole("button", { name: "Account menu", exact: true }),
  ).toBeInViewport();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollHeight <= window.innerHeight,
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath(
      `nimbus-${isMobile ? "mobile" : "desktop"}-scrolled.png`,
    ),
    animations: "disabled",
  });
  await page.getByRole("button", { name: "Grid view", exact: true }).click();
  await page.getByRole("main").hover();
  await page.mouse.wheel(0, 10_000);
  await expect(last).toBeInViewport();
  await expect(sort).toBeInViewport({ ratio: 1 });
  await sort.click();
  await page
    .getByRole(isMobile ? "button" : "option", {
      name: "Name (A to Z)",
      exact: true,
    })
    .click();
  await page.screenshot({
    path: testInfo.outputPath(
      `nimbus-${isMobile ? "mobile" : "desktop"}-grid-scrolled.png`,
    ),
    animations: "disabled",
  });
  await page.getByRole("button", { name: "List view", exact: true }).click();
  await expect
    .poll(async () => (await rpc.prefs.get.query()).view)
    .toBe("list");
  await last.click();
  await expect(page).toHaveURL(`/browse/${folder}/row-39`);
  await expect(
    page.getByRole("heading", { name: "This folder is empty", exact: true }),
  ).toBeVisible();
});
