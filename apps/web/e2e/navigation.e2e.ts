import { randomUUID } from "node:crypto";
import { expect } from "@playwright/test";
import { FileListing } from "@nimbus/api/file-listing";
import { client, test, chooseView } from "./helpers";

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
      .locator('[data-sidebar="header"]')
      .filter({ visible: true })
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
    // The plus and the label, together, sit in the middle of the button, give or take the 2 px
    // the button's design draws a leading icon closer to its edge than text.
    const contentCenter = await create.evaluate((element) => {
      const icon = element.querySelector("svg")?.getBoundingClientRect();
      const label = [...element.querySelectorAll("span")]
        .filter(
          (span) => span.textContent === "New" && !span.querySelector("span"),
        )
        .at(-1)
        ?.getBoundingClientRect();
      if (!icon || !label) return Number.NaN;
      return (icon.left + label.right) / 2;
    });
    expect(Math.abs(contentCenter - buttonCenter)).toBeLessThanOrEqual(2);
    await expect(
      page.getByRole("link", { name: "Settings", exact: true }),
    ).toHaveAttribute("href", "/settings");
    await expect(
      page
        .locator('[data-sidebar="footer"]')
        .filter({ visible: true })
        .getByRole("button", { name: "Theme", exact: true }),
    ).toHaveCount(0);
    const settings = page.getByRole("link", { name: "Settings", exact: true });
    await expect(settings).toHaveAccessibleName("Settings");
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
      // The row is not a link itself: one lies over it (see menuRowLink).
      await expect(
        page.getByRole("menuitem", { name, exact: true }).locator("a"),
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
      .locator('[data-sidebar="content"]')
      .filter({ visible: true })
      .getByRole("link");
    await expect(primary).toHaveCount(4);
    for (const [name, href] of [
      ["Files", "/"],
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
      // Collapsed, the sidebar is out of the way, New with it, until it opens again.
      await expect(create).not.toBeInViewport();
      await page
        .getByRole("button", { name: "Toggle Sidebar", exact: true })
        .click();
      await expect(create).toBeInViewport({ ratio: 1 });
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
          `nimbus-desktop-${theme.toLowerCase()}-reopened.png`,
        ),
        animations: "disabled",
      });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
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
  await chooseView(page, "Grid view", isMobile);
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
  await chooseView(page, "List view", isMobile);
  await expect
    .poll(async () => (await rpc.prefs.get.query()).view)
    .toBe("list");
  await last.click();
  await expect(page).toHaveURL(`/browse/${folder}/row-39`);
  await expect(
    page.getByRole("heading", { name: "This folder is empty", exact: true }),
  ).toBeVisible();
});

test("a missing folder says so at once, without an error toast", async ({
  page,
}) => {
  await page.goto(`/browse/missing-${randomUUID()}`);
  // Retrying a missing folder only delays the answer by several seconds.
  await expect(
    page.getByRole("heading", { name: "Folder not found", exact: true }),
  ).toBeVisible({ timeout: 4_000 });
  await expect(
    page
      .getByRole("region", { name: /Notifications/ })
      .getByText("no longer exists"),
  ).toHaveCount(0);
});

test("header and toolbar controls have 44 px touch areas on touch screens of every width", async ({
  page,
  context,
  isMobile,
}) => {
  const folder = `touch-${randomUUID()}`;
  const rpc = await client(context);
  await rpc.files.createFolder.mutate({ name: folder });
  await rpc.files.createFolder.mutate({ path: folder, name: "middle" });
  await rpc.files.createFolder.mutate({
    path: `${folder}/middle`,
    name: "inner",
  });
  // Two entries, so selecting one shows every action, Select all included.
  for (const name of ["leaf", "leaf-2"])
    await rpc.files.createFolder.mutate({
      path: `${folder}/middle/inner`,
      name,
    });
  type Scope = "header" | "selection";
  const measure = (scope: Scope) => {
    const named = (label: string) =>
      document.querySelector(`[aria-label="${label}"]`);
    const controls =
      scope === "selection"
        ? [
            ...document.querySelectorAll(
              '[role="toolbar"][aria-label="Selected items"] button',
            ),
          ]
        : [
            document.querySelector('[data-sidebar="trigger"]'),
            document.querySelector('header a[aria-label="Nimbus home"]'),
            document.querySelector('input[name="q"]'),
            named("Account menu"),
            document.querySelector(
              'nav[aria-label="breadcrumb"] a[aria-label="Files"]',
            ),
            [...document.querySelectorAll("button")].find((button) =>
              button.textContent?.includes("Show folders in this path"),
            ),
            named("Sort and filter options"),
            named("Sort files"),
            named("Group files by type"),
            named("List view"),
            named("Grid view"),
            [...document.querySelectorAll("button")].find(
              (button) => button.textContent?.trim() === "Split",
            ),
          ];
    return controls
      .filter((control) => control instanceof HTMLElement)
      .filter((control) => control.getBoundingClientRect().width > 0)
      .map((control) => {
        const box = control.getBoundingClientRect();
        const x = box.left + box.width / 2;
        const y = box.top + box.height / 2;
        const answers = [
          [-21, 0],
          [21, 0],
          [0, -21],
          [0, 21],
        ].every(([dx = 0, dy = 0]) => {
          const hit = document.elementFromPoint(x + dx, y + dy);
          return hit !== null && (control === hit || control.contains(hit));
        });
        return {
          name:
            control.getAttribute("aria-label") ??
            control.textContent?.trim() ??
            "",
          answers,
        };
      });
  };
  // The phone project has a touch screen, the desktop one a mouse. Touch decides, not width.
  const widths = isMobile ? [360, 390, 768, 1024, 1440] : [768, 1440];
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    // Three levels deep, so the breadcrumb shows the root link and the path folders button.
    await page.goto(`/browse/${folder}/middle/inner`);
    await expect(
      page.locator('[data-shape="folder-toolbar"]').first(),
    ).toBeVisible();
    // Each control answers a touch 21 px from its center in every direction, and no neighbor
    // takes it: a 44 px area of its own. With a mouse, controls keep their visible size.
    const header: Scope = "header";
    const areas = await page.evaluate(measure, header);
    expect(areas.length, `controls at ${width}`).toBeGreaterThanOrEqual(6);
    // Touch areas change no layout: the root crumb stays on one line.
    expect(
      await page
        .locator('nav[aria-label="breadcrumb"] a[aria-label="Files"]')
        .evaluate((link) => {
          const line = parseFloat(getComputedStyle(link).lineHeight);
          const label = [...link.children].find(
            (child) => child.getBoundingClientRect().width > 0,
          );
          return (label?.getBoundingClientRect().height ?? 0) <= line + 1;
        }),
      `root crumb on one line at ${width}`,
    ).toBe(true);
    // The current folder's name shows, truncated if need be, never cut off entirely.
    expect(
      await page
        .locator('nav[aria-label="breadcrumb"] [aria-current="page"]')
        .evaluate((current) => {
          const box = current.getBoundingClientRect();
          const list = current.closest("ol")?.getBoundingClientRect();
          return (
            list !== undefined && box.width >= 8 && box.right <= list.right + 1
          );
        }),
      `current folder shown at ${width}`,
    ).toBe(true);
    for (const area of areas)
      expect(area, `${area.name} at ${width}`).toEqual({
        name: area.name,
        answers: isMobile,
      });
    // Selecting swaps the toolbar for the selection's own. Ctrl+Space selects on every layout.
    await page
      .locator('[data-entry-name="leaf"]')
      .filter({ visible: true })
      .focus();
    await page.keyboard.press("Control+Space");
    await expect(
      page.getByRole("toolbar", { name: "Selected items" }),
    ).toContainText("1 selected");
    // Star waits for the current stars; a disabled button takes no touches.
    await expect(
      page
        .getByRole("toolbar", { name: "Selected items" })
        .getByRole("button", { name: /star/i }),
    ).toBeEnabled();
    // Every action fits in the bar, none pushed out of view beside the sidebar.
    expect(
      await page
        .getByRole("toolbar", { name: "Selected items" })
        .evaluate((bar) => {
          const outer = bar.getBoundingClientRect();
          return [...bar.querySelectorAll("button")]
            .map((button) => button.getBoundingClientRect())
            .every(
              (box) =>
                box.left >= outer.left - 1 &&
                box.right <= outer.right + 1 &&
                box.right <= innerWidth,
            );
        }),
      `selection actions fit at ${width}`,
    ).toBe(true);
    const selected: Scope = "selection";
    const selection = await page.evaluate(measure, selected);
    expect(
      selection.length,
      `selection controls at ${width}`,
    ).toBeGreaterThanOrEqual(6);
    for (const area of selection)
      expect(area, `${area.name} at ${width}`).toEqual({
        name: area.name,
        answers: isMobile,
      });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
    ).toBe(false);
  }
});

test("New is offered only where something can be created", async ({
  page,
  isMobile,
}) => {
  const fab = page.getByRole("button", { name: "New file or folder" });
  const sidebarNew = page.getByRole("button", { name: "New", exact: true });
  const offered = isMobile ? fab : sidebarNew;
  await page.goto("/");
  await expect(offered).toBeVisible();
  await page.goto("/trash");
  await expect(
    page.getByRole("heading", { name: "Trash", exact: true }),
  ).toBeVisible();
  await expect(offered).toBeHidden();
  // Pages that are not a folder have nowhere to create in, rather than the drive root.
  for (const [address, heading] of [
    ["/trash/", "Trash"],
    ["/recent", "Recent"],
    ["/starred", "Starred"],
    ["/shared", "Shared"],
    ["/search?q=alpha", "Search: alpha"],
  ]) {
    await page.goto(address);
    await expect(
      page.getByRole("heading", { name: heading, exact: true }),
    ).toBeVisible();
    await expect(offered).toBeHidden();
  }
  await page.goto(`/browse/missing-${randomUUID()}`);
  await expect(
    page.getByRole("heading", { name: "Folder not found", exact: true }),
  ).toBeVisible();
  await expect(offered).toBeHidden();
});

test("an empty folder suggests dropping files only where files can be dragged in", async ({
  page,
  context,
  isMobile,
}) => {
  const folder = `empty-${randomUUID()}`;
  await (await client(context)).files.createFolder.mutate({ name: folder });
  await page.goto(`/browse/${folder}`);
  await expect(page.getByText("This folder is empty")).toBeVisible();
  // The phone project has a touch screen only; the desktop one has a mouse.
  const drop = page.getByText(
    "Drop files here or use the New button to add content",
  );
  const tap = page.getByText("Tap New to upload files or create a folder");
  await expect(isMobile ? tap : drop).toBeVisible();
  await expect(isMobile ? drop : tap).toBeHidden();
});

test("on a phone the share dialog keeps Create link in reach without scrolling", async ({
  page,
  context,
  isMobile,
}) => {
  test.skip(
    !isMobile,
    "Phones only; wider screens show the button in the form.",
  );
  const folder = `share-reach-${randomUUID()}`;
  const rpc = await client(context);
  await rpc.files.createFolder.mutate({ name: folder });
  await rpc.files.createFolder.mutate({ path: folder, name: "inside" });
  await page.setViewportSize({ width: 390, height: 560 });
  await page.goto(`/browse/${folder}`);
  await page
    .getByRole("button", { name: "Actions for inside", exact: true })
    .click();
  await page.getByRole("button", { name: "Share", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Share inside" });
  const create = dialog.getByRole("button", { name: "Create link" });
  await expect(create).toHaveCount(1);
  await expect(create).toBeInViewport({ ratio: 1 });
  expect(
    await create.evaluate((button) => {
      const box = button.getBoundingClientRect();
      // The button's own label or fill, not something over it.
      return button.contains(
        document.elementFromPoint(
          box.left + box.width / 2,
          box.top + box.height / 2,
        ),
      );
    }),
  ).toBe(true);
  await create.click();
  await expect(
    dialog.getByRole("textbox", { name: "Share link" }),
  ).toBeInViewport();
});

test("New closes and creates nothing once the page has nowhere to create in", async ({
  page,
  context,
  isMobile,
}) => {
  const rpc = await client(context);
  const rootNames = async () =>
    FileListing.entries(await rpc.files.list.query({ path: "" })).map(
      (item) => item.name,
    );
  const before = await rootNames();
  const openNew = () =>
    page
      .getByRole("button", {
        name: isMobile ? "New file or folder" : "New",
        exact: true,
      })
      .click();
  const newFolder = page.getByRole(isMobile ? "button" : "menuitem", {
    name: "New folder",
    exact: true,
  });
  const upload = page.getByRole(isMobile ? "button" : "menuitem", {
    name: "Upload file",
    exact: true,
  });

  // In-app navigation keeps the page, so whatever New had open must close by itself.
  const sidebarLink = async (name: string) => {
    if (isMobile)
      await page
        .getByRole("button", { name: "Toggle Sidebar", exact: true })
        .click();
    await page.getByRole("link", { name, exact: true }).first().click();
    if (isMobile) await page.keyboard.press("Escape");
  };
  // A menu or drawer open when Back returns to Trash closes, and does not come back.
  await page.goto("/");
  await sidebarLink("Trash");
  await expect(
    page.getByRole("heading", { name: "Trash", exact: true }),
  ).toBeVisible();
  await sidebarLink("Files");
  await expect(
    page.getByRole("heading", { name: "Files", exact: true }),
  ).toBeVisible();
  await openNew();
  await expect(newFolder).toBeVisible();
  await page.goBack();
  await expect(
    page.getByRole("heading", { name: "Trash", exact: true }),
  ).toBeVisible();
  await expect(newFolder).toBeHidden();
  await expect(upload).toBeHidden();
  await page.goForward();
  await expect(
    page.getByRole("heading", { name: "Files", exact: true }),
  ).toBeVisible();
  await expect(newFolder).toBeHidden();

  // A New folder dialog open when Back returns to Trash closes without creating.
  await openNew();
  await newFolder.click();
  const dialog = page.getByRole("dialog", { name: "New folder", exact: true });
  await dialog.getByRole("textbox").fill(`never-${randomUUID().slice(0, 8)}`);
  await page.goBack();
  await expect(
    page.getByRole("heading", { name: "Trash", exact: true }),
  ).toBeVisible();
  await expect(dialog).toBeHidden();
  expect(await rootNames()).toEqual(before);
});

test("the path shows the parent folder wherever it has room, beside the sidebar open or folded", async ({
  page,
  context,
  isMobile,
}) => {
  test.skip(isMobile, "The sizes are set explicitly; one project is enough.");
  const rpc = await client(context);
  const top = `trail-${randomUUID().slice(0, 8)}`;
  await rpc.files.createFolder.mutate({ name: top });
  await rpc.files.createFolder.mutate({ path: top, name: "lakes" });
  await rpc.files.createFolder.mutate({ path: `${top}/lakes`, name: "summer" });
  const trail = page.getByRole("navigation", { name: "breadcrumb" });
  const parent = trail.getByRole("link", { name: "lakes", exact: true });
  const toggle = page.getByRole("button", {
    name: "Toggle Sidebar",
    exact: true,
  });
  // 900 px wide: the open sidebar leaves the path too little room for its parent; folded, it fits.
  await page.setViewportSize({ width: 900, height: 700 });
  await page.goto(`/browse/${top}/lakes/summer`);
  const sidebar = page.locator('[data-slot="sidebar"]').first();
  if ((await sidebar.getAttribute("data-state")) !== "expanded")
    await toggle.click();
  await expect(sidebar).toHaveAttribute("data-state", "expanded");
  await expect(parent).toBeHidden();
  await toggle.click();
  await expect(sidebar).toHaveAttribute("data-state", "collapsed");
  await expect(parent).toBeVisible();
});
