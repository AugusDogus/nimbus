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
          '[data-slot="sidebar"] [data-sidebar="menu-button"]',
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
    const sidebar = document.querySelector('[data-slot="sidebar"]');
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
        '[data-slot="sidebar"] a[href="/trash"]',
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

test("opening and closing a split view leaves the header where it was", async ({
  page,
  context,
  isMobile,
}) => {
  test.skip(isMobile, "Phones show one folder at a time.");
  const folder = `steady-${randomUUID()}`;
  await (await client(context)).files.createFolder.mutate({ name: folder });
  await page.goto(`/browse/${folder}`);
  await expect(page.getByText("This folder is empty")).toBeVisible();
  // Every control in the header, where it is.
  const controls = () =>
    page.locator('[data-slot="sidebar-inset"] > header').evaluate((header) =>
      [...header.querySelectorAll("button, input")].map((control) => {
        const box = control.getBoundingClientRect();
        return [
          control.getAttribute("aria-label") ?? control.tagName,
          box.x,
          box.y,
          box.width,
          box.height,
        ];
      }),
    );
  // The folder's card, and its Back and path, which become the left pane's.
  const card = () =>
    page
      .locator('[data-slot="folder-card"]')
      .first()
      .evaluate((section) =>
        [
          section,
          section.querySelector('[aria-label="Back"]'),
          section.querySelector('[data-slot="breadcrumb-page"]'),
        ].map((element) => {
          const box = element?.getBoundingClientRect();
          return box ? [box.x, box.y, box.height] : null;
        }),
      );
  const before = await controls();
  const single = await card();
  const toggle = page.getByRole("button", { name: "Split view" });
  for (const round of [1, 2]) {
    await toggle.click();
    await expect(page.locator("[data-pane]")).toHaveCount(2);
    expect(await controls(), `split, round ${round}`).toEqual(before);
    expect(await card(), `left pane, round ${round}`).toEqual(single);
    await toggle.click();
    await expect(page.locator("[data-pane]")).toHaveCount(0);
    expect(await controls(), `single, round ${round}`).toEqual(before);
    expect(await card(), `single card, round ${round}`).toEqual(single);
  }
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
  // The page area never scrolls: content scrolls on its card, below the header on the tint.
  const frame = () =>
    page.evaluate(() => {
      const area = document.querySelector('[data-slot="sidebar-inset"]');
      const card = document.querySelector(
        '[data-slot="page-card"], [data-slot="folder-card"]',
      );
      const header = area?.querySelector(":scope > header");
      if (!area || !card || !header) return null;
      const box = card.getBoundingClientRect();
      return {
        areaScrolls: area.scrollHeight > area.clientHeight,
        cardScrolls: card.scrollHeight > card.clientHeight,
        header: header.getBoundingClientRect().width,
        card: [box.x, box.width],
      };
    });
  await page.goto("/settings/account");
  await expect(
    page.getByRole("heading", { name: "Account", exact: true }),
  ).toBeVisible();
  const scrolling = await frame();
  expect(scrolling).toMatchObject({ areaScrolls: false, cardScrolls: true });
  await page.goto(`/browse/${empty}`);
  await expect(page.getByText("This folder is empty")).toBeVisible();
  const still = await frame();
  expect(still).toMatchObject({ areaScrolls: false, cardScrolls: false });
  expect(still?.header).toBe(scrolling?.header);
  expect(still?.card).toEqual(scrolling?.card);
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
    // Collapsed, the sidebar is out of the way: move within the app as its links would.
    else if ((await sidebar.getAttribute("data-state")) === "collapsed") {
      await page.evaluate(
        (href) => {
          history.pushState(null, "", href);
          dispatchEvent(new PopStateEvent("popstate"));
        },
        name === "Settings" ? "/settings" : "/",
      );
      return;
    }
    await page
      .locator('[data-sidebar="sidebar"]')
      .filter({ visible: true })
      .getByRole("link", { name, exact: true })
      .click();
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
