import { randomUUID } from "node:crypto";
import { expect, type Page } from "@playwright/test";
import { client, test } from "./helpers";

// Scrollbars take space, as on most desktop browsers, rather than overlaying the page.
test.use({ launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] } });

/** Every sidebar item's box, by its name. */
const itemBoxes = (page: Page) =>
  page.evaluate(() =>
    Object.fromEntries(
      [
        ...document.querySelectorAll(
          '[data-slot="sidebar-container"] [data-sidebar="menu-button"]',
        ),
      ].map((item) => {
        const box = item.getBoundingClientRect();
        const name =
          item.textContent || item.getAttribute("aria-label") || "unnamed";
        const entry: [string, number[]] = [
          name,
          [box.x, box.y, box.width, box.height],
        ];
        return entry;
      }),
    ),
  );

test("opening a folder leaves the sidebar exactly as it was", async ({
  page,
  context,
  isMobile,
}) => {
  test.skip(isMobile, "The sidebar is a closed sheet on phones.");
  const folder = `steady-${randomUUID()}`;
  await (await client(context)).files.createFolder.mutate({ name: folder });
  await page.goto("/");
  const storage = page.getByRole("region", { name: "Storage usage" });
  await expect(storage.getByText("Nimbus files")).toBeVisible();
  const before = await itemBoxes(page);
  // Records, until the folder shows, whether the storage panel left the page or New changed.
  await page.evaluate(() => {
    const changes: string[] = [];
    Object.assign(window, { sidebarChanges: changes });
    const sidebar = document.querySelector('[data-slot="sidebar-container"]');
    if (!sidebar) throw new Error("The desktop sidebar is not on the page.");
    new MutationObserver((records) => {
      for (const record of records) {
        if (
          [...record.removedNodes].some(
            (node) =>
              node instanceof Element &&
              node.matches('[aria-label="Storage usage"]'),
          )
        )
          changes.push("storage removed");
        if (
          record.attributeName === "disabled" &&
          record.target instanceof Element &&
          record.target.getAttribute("aria-label") === "New"
        )
          changes.push("New disabled changed");
      }
    }).observe(sidebar, { subtree: true, childList: true, attributes: true });
  });
  await page.getByRole("link", { name: folder, exact: true }).click();
  await expect(page).toHaveURL(`/browse/${folder}`);
  await expect(page.getByText("This folder is empty")).toBeVisible();
  expect(
    await page.evaluate(() =>
      "sidebarChanges" in window ? window.sidebarChanges : null,
    ),
  ).toEqual([]);
  expect(await itemBoxes(page)).toEqual(before);
});

test("New hides in the frame that leaving a folder shows the next page", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, "Phones offer New as a floating button instead.");
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "New", exact: true }),
  ).toBeVisible();
  // Samples every frame: once Trash is the current page, New must already be hidden.
  await page.evaluate(() => {
    const late: string[] = [];
    Object.assign(window, { lateNew: late });
    const sample = () => {
      const trash = document.querySelector(
        '[data-slot="sidebar-container"] a[href="/trash"]',
      );
      const create = document.querySelector('button[aria-label="New"]');
      if (
        trash?.getAttribute("aria-current") === "page" &&
        create &&
        getComputedStyle(create).visibility !== "hidden"
      )
        late.push(`${Math.round(performance.now())} ms`);
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await page
    .locator('[data-slot="sidebar"]')
    .getByRole("link", { name: "Trash", exact: true })
    .click();
  await expect(page.getByRole("heading", { name: "Trash" })).toBeVisible();
  await page.waitForTimeout(400);
  expect(
    await page.evaluate(() => ("lateNew" in window ? window.lateNew : null)),
  ).toEqual([]);
});

test("a page that scrolls is as wide as one that does not", async ({
  page,
  context,
  isMobile,
}) => {
  test.skip(isMobile, "Phone scrollbars overlay the page.");
  // An empty folder is short however full the rest of the drive is.
  const empty = `steady-${randomUUID()}`;
  await (await client(context)).files.createFolder.mutate({ name: empty });
  const headerWidth = () =>
    page
      .locator('[data-slot="sidebar-inset"] > header')
      .evaluate((header) => header.getBoundingClientRect().width);
  await page.goto("/settings/account");
  await expect(
    page.getByRole("heading", { name: "Account", exact: true }),
  ).toBeVisible();
  expect(
    await page
      .locator('[data-slot="sidebar-inset"]')
      .evaluate((main) => main.scrollHeight > main.clientHeight),
  ).toBe(true);
  const scrolling = await headerWidth();
  await page.goto(`/browse/${empty}`);
  await expect(page.getByText("This folder is empty")).toBeVisible();
  expect(
    await page
      .locator('[data-slot="sidebar-inset"]')
      .evaluate((main) => main.scrollHeight > main.clientHeight),
  ).toBe(false);
  expect(await headerWidth()).toBe(scrolling);
});

test("Settings and the files pages share one sidebar", async ({
  page,
  isMobile,
}) => {
  const node = isMobile
    ? '[data-slot="sidebar-wrapper"]'
    : '[data-slot="sidebar"]';
  const sameNode = () =>
    page.evaluate(
      (selector) =>
        "sidebarNode" in window &&
        window.sidebarNode === document.querySelector(selector),
      node,
    );
  const sidebar = page.locator('[data-slot="sidebar"]');
  const go = async (name: string) => {
    if (isMobile)
      await page.getByRole("button", { name: "Toggle Sidebar" }).click();
    await sidebar.getByRole("link", { name, exact: true }).click();
  };
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Account menu" }),
  ).toBeVisible();
  if (!isMobile) {
    // A collapsed sidebar stays collapsed in Settings and back.
    await page.getByRole("button", { name: "Toggle Sidebar" }).click();
    await expect(sidebar).toHaveAttribute("data-state", "collapsed");
  }
  await page.evaluate((selector) => {
    Object.assign(window, { sidebarNode: document.querySelector(selector) });
  }, node);
  await go("Settings");
  await expect(page).toHaveURL("/settings/appearance");
  expect(await sameNode()).toBe(true);
  if (!isMobile)
    await expect(sidebar).toHaveAttribute("data-state", "collapsed");
  await go("Back to files");
  await expect(page).toHaveURL("/");
  expect(await sameNode()).toBe(true);
  if (!isMobile)
    await expect(sidebar).toHaveAttribute("data-state", "collapsed");
});
