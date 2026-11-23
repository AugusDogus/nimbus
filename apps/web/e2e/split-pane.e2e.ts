import { randomUUID } from "node:crypto";
import { expect, type Locator, type Page } from "@playwright/test";
import { FileListing } from "@nimbus/api/file-listing";
import { client, test, whenCanCreate } from "./helpers";

const leftPane = (page: Page) => page.locator('[data-pane="left"]');
const rightPane = (page: Page) => page.locator('[data-pane="right"]');
const entry = (pane: Locator, name: string) =>
  pane.locator(`[data-entry-name="${name}"]`);

/** Folders a test made at the drive root, put in trash once it ends, so runs do not pile up. */
const leftAtRoot: string[] = [];
test.afterEach(async ({ context }) => {
  const rpc = await client(context);
  for (const path of leftAtRoot.splice(0))
    await rpc.files.delete.mutate({ path }).catch(() => undefined);
});

/**
 * A folder of its own at the drive root holding `Projects` (two folders and two notes) and
 * `Archive` (a year folder and a report that clashes with the one in Projects).
 */
async function seed(page: Page) {
  const rpc = await client(page.context());
  const root = `split-${randomUUID()}`;
  leftAtRoot.push(root);
  await rpc.files.createFolder.mutate({ name: root });
  for (const name of ["Projects", "Archive"])
    await rpc.files.createFolder.mutate({ path: root, name });
  for (const name of ["Client Alpha", "Client Beta"])
    await rpc.files.createFolder.mutate({ path: `${root}/Projects`, name });
  await rpc.files.createFolder.mutate({
    path: `${root}/Archive`,
    name: "2025",
  });
  const names = async (path: string) =>
    FileListing.entries(await rpc.files.list.query({ path })).map(
      (item) => item.name,
    );
  return { rpc, root, names };
}

/** Puts a text file into `folder` through the upload endpoint the page uses. */
async function putFile(page: Page, folder: string, name: string, body: string) {
  await page.goto(`/browse/${folder}`);
  await whenCanCreate(page);
  await page
    .locator('input[type="file"]')
    .setInputFiles({ name, mimeType: "text/plain", buffer: Buffer.from(body) });
  await expect(page.locator(`[data-entry-name="${name}"]`)).toBeVisible();
}

const splitHref = (root: string, active: "left" | "right" = "left") =>
  `/browse/${root}/Projects?right=${encodeURIComponent(`${root}/Archive`)}&active=${active}&ratio=50`;

test.describe("split view on a wide screen", () => {
  test.skip(({ isMobile }) => isMobile, "Phones show one folder at a time.");

  test("opens beside the folder, browses and selects each pane on its own, and closes to the active pane", async ({
    page,
  }) => {
    const { root } = await seed(page);
    await page.goto(`/browse/${root}/Projects`);
    await page.getByRole("button", { name: "Split view" }).click();
    // The right pane starts at the same folder.
    await expect(page).toHaveURL(
      new RegExp(`right=${encodeURIComponent(`${root}/Projects`)}`),
    );
    await expect(entry(rightPane(page), "Client Alpha")).toBeVisible();
    // A wide screen has room for both panes beside the open sidebar.
    await expect(
      page.locator('[data-slot="sidebar"][data-state]'),
    ).toHaveAttribute("data-state", "expanded");

    await rightPane(page).getByRole("button", { name: "Up one level" }).click();
    await entry(rightPane(page), "Archive").click();
    await expect(entry(rightPane(page), "2025")).toBeVisible();
    await expect(entry(leftPane(page), "Client Alpha")).toBeVisible();
    await expect(page).toHaveURL(splitHref(root, "right"));
    await expect(rightPane(page)).toHaveAttribute(
      "aria-label",
      "Right pane (active)",
    );

    // Selecting in one pane leaves the other's selection alone.
    await entry(leftPane(page), "Client Beta").click({
      modifiers: ["ControlOrMeta"],
    });
    await expect(leftPane(page).getByText("1 selected")).toBeVisible();
    await expect(
      rightPane(page).getByRole("toolbar", { name: "Selected items" }),
    ).toHaveCount(0);
    await expect(leftPane(page)).toHaveAttribute(
      "aria-label",
      "Left pane (active)",
    );
    // Each pane's Back returns that pane alone, the way it came: up, then into Archive.
    await rightPane(page).getByRole("button", { name: "Back" }).click();
    await expect(entry(rightPane(page), "Projects")).toBeVisible();
    await rightPane(page).getByRole("button", { name: "Back" }).click();
    await expect(entry(rightPane(page), "Client Alpha")).toBeVisible();
    await expect(
      rightPane(page).getByRole("button", { name: "Back" }),
    ).toBeDisabled();
    await expect(leftPane(page).getByText("1 selected")).toBeVisible();

    // Closing a pane keeps the other one's folder. The selection bar covers the pane's header.
    await entry(rightPane(page), "Client Alpha").click();
    await leftPane(page)
      .getByRole("button", { name: "Clear selection" })
      .click();
    await leftPane(page)
      .getByRole("button", { name: "Close this pane" })
      .click();
    await expect(page).toHaveURL(`/browse/${root}/Projects/Client%20Alpha`);
    await expect(page.locator("[data-pane]")).toHaveCount(0);
    await expect(page.getByText("This folder is empty")).toBeVisible();
  });

  test("opens on a listed folder with its rows at once, keeping the first listing, after one load", async ({
    page,
  }) => {
    const { root } = await seed(page);
    const scripts: string[] = [];
    page.on("request", (request) => {
      if (request.resourceType() === "script")
        scripts.push(new URL(request.url()).pathname);
    });
    await page.goto(`/browse/${root}/Projects`);
    await expect(entry(page.locator("main"), "Client Alpha")).toBeVisible();
    const listing = await page.getByRole("grid").elementHandle();
    // Records any moment the split shows a loading state or a pane without its rows.
    await page.evaluate(() => {
      const seen: string[] = [];
      Object.assign(window, { splitStates: seen });
      new MutationObserver(() => {
        const right = document.querySelector('[data-pane="right"]');
        if (!right) return;
        if (document.querySelector('[data-slot="skeleton"]'))
          seen.push("loading");
        if (!right.querySelector("[data-entry-name]"))
          seen.push("right pane without rows");
      }).observe(document.body, { childList: true, subtree: true });
    });

    await page.getByRole("button", { name: "Split view" }).click();
    await expect(entry(rightPane(page), "Client Alpha")).toBeVisible();
    expect(
      await page.evaluate(() =>
        "splitStates" in window ? window.splitStates : null,
      ),
    ).toEqual([]);
    // The first folder's listing is the one it had, not a new one.
    expect(await listing?.evaluate((grid) => grid.isConnected)).toBe(true);
    // The split view's code is one load: its own file, with no opener loaded before it.
    expect(
      scripts.filter((path) => /\/split-view[-.]/.test(path)),
    ).toHaveLength(1);
    expect(scripts.filter((path) => /\/open-split[-.]/.test(path))).toEqual([]);

    // Closing keeps the same listing too.
    await page.getByRole("button", { name: "Split view" }).click();
    await expect(page.locator("[data-pane]")).toHaveCount(0);
    expect(await listing?.evaluate((grid) => grid.isConnected)).toBe(true);
  });

  test("opens when the toggle is used before the split view's code has arrived", async ({
    page,
  }) => {
    const { root } = await seed(page);
    // Holds the split view's code back, so the click comes before any preload has finished.
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(/\/split-view[-.]/, async (route) => {
      await held;
      await route.continue();
    });
    await page.goto(`/browse/${root}/Projects`);
    await expect(entry(page.locator("main"), "Client Alpha")).toBeVisible();
    await page.getByRole("button", { name: "Split view" }).click();
    // Nothing changes until the code is here; then the split opens as usual.
    await expect(page.locator("[data-pane]")).toHaveCount(0);
    release();
    await expect(entry(rightPane(page), "Client Alpha")).toBeVisible();
    await expect(entry(leftPane(page), "Client Alpha")).toBeVisible();
  });

  test("shows both panes when another page opens a split address", async ({
    page,
  }) => {
    const { root } = await seed(page);
    // With the split view's code loaded, the page and its split mount together.
    await page.goto(splitHref(root));
    await expect(entry(rightPane(page), "2025")).toBeVisible();
    await page
      .getByRole("link", { name: "Shared", exact: true })
      .first()
      .click();
    await expect(page).toHaveURL(/\/shared/);
    await page.goBack();
    await expect(entry(rightPane(page), "2025")).toBeVisible();
    await expect(entry(leftPane(page), "Client Alpha")).toBeVisible();
  });

  test("names the active pane, not only colours it", async ({ page }) => {
    const { root } = await seed(page);
    await page.goto(splitHref(root));
    await expect(entry(rightPane(page), "2025")).toBeVisible();
    await expect(
      page.getByRole("region", { name: "Left pane (active)", exact: true }),
    ).toHaveAttribute("aria-current", "true");
    const right = page.getByRole("region", { name: "Right pane", exact: true });
    await expect(right).toBeVisible();
    await expect(right).not.toHaveAttribute("aria-current", /.*/);

    await entry(rightPane(page), "2025").click({
      modifiers: ["ControlOrMeta"],
    });
    await expect(
      page.getByRole("region", { name: "Right pane (active)", exact: true }),
    ).toHaveAttribute("aria-current", "true");
    await expect(
      page.getByRole("region", { name: "Left pane", exact: true }),
    ).toBeVisible();
  });

  test("folds the sidebar when only that makes room for both panes, and opens it when the split closes", async ({
    page,
  }) => {
    const { root } = await seed(page);
    await page.setViewportSize({ width: 1100, height: 800 });
    await page.goto(`/browse/${root}/Projects`);
    await expect(entry(page.locator("main"), "Client Alpha")).toBeVisible();
    const sidebar = page.locator('[data-slot="sidebar"][data-state]');
    await expect(sidebar).toHaveAttribute("data-state", "expanded");
    const toggle = page.getByRole("button", { name: "Split view" });

    await toggle.click();
    await expect(sidebar).toHaveAttribute("data-state", "collapsed");
    await expect(page.locator("[data-pane]")).toHaveCount(2);
    await expect(entry(rightPane(page), "Client Alpha")).toBeVisible();
    // Opening the drive root in a pane keeps the split, and the sidebar folded.
    await leftPane(page).getByRole("link", { name: "Files" }).click();
    await expect(page).toHaveURL(/\/\?right=/);
    await expect(page.locator("[data-pane]")).toHaveCount(2);
    await expect(sidebar).toHaveAttribute("data-state", "collapsed");

    await toggle.click();
    await expect(page.locator("[data-pane]")).toHaveCount(0);
    await expect(sidebar).toHaveAttribute("data-state", "expanded");
  });

  test("searching from a split view keeps it: a folder opened from the results goes to the active pane", async ({
    page,
  }) => {
    const { root } = await seed(page);
    await page.goto(splitHref(root, "right"));
    await expect(entry(rightPane(page), "2025")).toBeVisible();
    const box = page.getByRole("combobox", { name: "Search files" });
    const result = page.locator(`[data-entry-name="${root}"]`);
    // New folders reach the search index asynchronously.
    await expect(async () => {
      await box.fill(root);
      await box.press("Enter");
      await expect(result).toBeVisible({ timeout: 2_000 });
    }).toPass();
    await expect(page).toHaveURL(/\/search\?.*left=/);
    await expect(
      page.getByText("Folders open in the right pane of your split view."),
    ).toBeVisible();

    await result.click();
    await expect(page).toHaveURL(
      `/browse/${root}/Projects?right=${encodeURIComponent(root)}&active=right&ratio=50`,
    );
    await expect(entry(rightPane(page), "Archive")).toBeVisible();
    await expect(entry(leftPane(page), "Client Alpha")).toBeVisible();
  });

  test("restores both panes on reload and with Back and Forward", async ({
    page,
  }) => {
    const { root } = await seed(page);
    await page.goto(splitHref(root));
    await entry(leftPane(page), "Client Alpha").click();
    await expect(page).toHaveURL(
      new RegExp(`/browse/${root}/Projects/Client%20Alpha\\?right=`),
    );
    await page.reload();
    await expect(entry(rightPane(page), "2025")).toBeVisible();
    await expect(
      leftPane(page).getByText("This folder is empty"),
    ).toBeVisible();
    await page.goBack();
    await expect(entry(leftPane(page), "Client Beta")).toBeVisible();
    await expect(entry(rightPane(page), "2025")).toBeVisible();
    await page.goForward();
    await expect(
      leftPane(page).getByText("This folder is empty"),
    ).toBeVisible();
    // An address without split params shows one folder, as before.
    await page.goto(`/browse/${root}/Projects`);
    await expect(
      page.locator('[data-entry-name="Client Alpha"]'),
    ).toBeVisible();
    await expect(page.locator("[data-pane]")).toHaveCount(0);
  });

  test("moves by dragging to the other pane and copies with Ctrl, with Undo and the clash choices", async ({
    page,
  }) => {
    const { root, names } = await seed(page);
    await putFile(page, `${root}/Projects`, "Notes.txt", "Draft notes");
    await putFile(page, `${root}/Projects`, "Report.txt", "Project report");
    await putFile(page, `${root}/Archive`, "Report.txt", "Archived report");
    await page.goto(splitHref(root));
    await expect(entry(rightPane(page), "2025")).toBeVisible();
    const target = await rightPane(page).boundingBox();
    if (!target) throw new Error("The right pane has no box to drop on.");
    // Below the pane's rows and above where reports appear.
    const emptySpace = {
      x: target.x + target.width / 3,
      y: target.y + target.height * 0.6,
    };

    await entry(leftPane(page), "Notes.txt").hover();
    await page.mouse.down();
    await page.mouse.move(emptySpace.x, emptySpace.y, { steps: 6 });
    await page.mouse.move(emptySpace.x + 10, emptySpace.y, { steps: 2 });
    await expect(
      page.getByRole("status").filter({ hasText: "Move to “Archive”" }),
    ).toBeVisible();
    await page.mouse.up();
    await expect(entry(rightPane(page), "Notes.txt")).toBeVisible();
    await expect(entry(leftPane(page), "Notes.txt")).toHaveCount(0);
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await expect(entry(leftPane(page), "Notes.txt")).toBeVisible();
    await expect(entry(rightPane(page), "Notes.txt")).toHaveCount(0);

    // Holding Ctrl copies; the taken name opens the choices instead of being renamed unasked.
    await entry(leftPane(page), "Report.txt").hover();
    await page.mouse.down();
    await page.keyboard.down("Control");
    await page.mouse.move(emptySpace.x, emptySpace.y, { steps: 6 });
    await page.mouse.move(emptySpace.x + 10, emptySpace.y, { steps: 2 });
    await expect(
      page.getByRole("status").filter({ hasText: "Copy to “Archive”" }),
    ).toBeVisible();
    await page.mouse.up();
    await page.keyboard.up("Control");
    const picker = page.locator("[data-picker]");
    await expect(
      picker.getByText("“Report.txt” is already in Archive"),
    ).toBeVisible();
    await picker
      .getByRole("button", { name: "Keep both", exact: true })
      .click();
    await expect(entry(rightPane(page), "Report (1).txt")).toBeVisible();
    // A copy leaves the original where it was.
    await expect(entry(leftPane(page), "Report.txt")).toBeVisible();
    expect(await names(`${root}/Archive`)).toEqual(
      expect.arrayContaining(["Report.txt", "Report (1).txt"]),
    );
  });

  test("moves and copies the selection to the other pane from the selection bar and the keyboard", async ({
    page,
  }) => {
    const { root, names } = await seed(page);
    await page.goto(splitHref(root));
    await expect(entry(rightPane(page), "2025")).toBeVisible();

    await entry(leftPane(page), "Client Alpha").click({
      modifiers: ["ControlOrMeta"],
    });
    const bar = leftPane(page).getByRole("toolbar", { name: "Selected items" });
    await bar.getByRole("button", { name: "Copy to Archive" }).click();
    await expect(entry(rightPane(page), "Client Alpha")).toBeVisible();
    await expect(entry(leftPane(page), "Client Alpha")).toBeVisible();
    await bar.getByRole("button", { name: "Clear selection" }).click();

    await entry(leftPane(page), "Client Beta").click({
      modifiers: ["ControlOrMeta"],
    });
    await bar.getByRole("button", { name: "Move to Archive" }).click();
    await expect(entry(rightPane(page), "Client Beta")).toBeVisible();
    await expect(entry(leftPane(page), "Client Beta")).toHaveCount(0);
    expect(await names(`${root}/Archive`)).toEqual(
      expect.arrayContaining(["2025", "Client Alpha", "Client Beta"]),
    );

    // A backslash moves focus to the other pane, which becomes active; a bar closes the split
    // to it. Neither is a browser shortcut, and function keys stay with the browser.
    await entry(leftPane(page), "Client Alpha").focus();
    await page.keyboard.press("\\");
    await expect(rightPane(page).locator(":focus")).toHaveCount(1);
    await expect(page).toHaveURL(/active=right/);
    await page.keyboard.press("|");
    await expect(page).toHaveURL(`/browse/${root}/Archive`);
    // And opens it again from a listing.
    await page.locator('[data-entry-name="2025"]').focus();
    await page.keyboard.press("|");
    await expect(page.locator("[data-pane]")).toHaveCount(2);
  });

  test("opens a folder in the other pane from its menu", async ({ page }) => {
    const { root } = await seed(page);
    await page.goto(`/browse/${root}/Projects`);
    await page
      .locator('[data-entry-name="Client Beta"]')
      .click({ button: "right" });
    await page
      .getByRole("menuitem", { name: "Open in other pane", exact: true })
      .click();
    await expect(
      rightPane(page).getByText("This folder is empty"),
    ).toBeVisible();
    // The search params spell a space as a plus.
    await expect(page).toHaveURL(/right=.*Client\+Beta/);
    await expect(entry(leftPane(page), "Client Alpha")).toBeVisible();
  });

  test("uploads into the pane under the pointer, and New uploads into the active pane", async ({
    page,
  }) => {
    const { root, names } = await seed(page);
    await page.goto(splitHref(root));
    await expect(entry(rightPane(page), "2025")).toBeVisible();
    const files = await page.evaluateHandle(() => {
      const transfer = new DataTransfer();
      transfer.items.add(
        new File(["From the desktop."], "Dropped notes.txt", {
          type: "text/plain",
        }),
      );
      return transfer;
    });
    // Dropping on the inactive pane does not make it active, and the file goes there.
    await rightPane(page).dispatchEvent("dragover", { dataTransfer: files });
    await expect(
      page.getByRole("status").filter({ hasText: "Upload to “Archive”" }),
    ).toBeVisible();
    await rightPane(page).dispatchEvent("drop", { dataTransfer: files });
    await files.dispose();
    await expect(entry(rightPane(page), "Dropped notes.txt")).toBeVisible();
    await expect(page).toHaveURL(/active=left/);

    // New acts on the active pane: here the right one, once clicked.
    await rightPane(page)
      .getByRole("columnheader", { name: "Folders" })
      .click();
    await expect(page).toHaveURL(/active=right/);
    await whenCanCreate(page);
    await page.locator('input[type="file"]').setInputFiles({
      name: "From New.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("Uploaded with New."),
    });
    await expect(entry(rightPane(page), "From New.txt")).toBeVisible();
    expect(await names(`${root}/Archive`)).toEqual(
      expect.arrayContaining(["Dropped notes.txt", "From New.txt"]),
    );
    expect(await names(`${root}/Projects`)).not.toContain("From New.txt");
  });

  test("the divider resizes, catches at the middle, resets, steps by keyboard and folds a pane away", async ({
    page,
  }) => {
    const { root } = await seed(page);
    await page.goto(splitHref(root));
    await expect(entry(rightPane(page), "2025")).toBeVisible();
    const divider = page.getByRole("separator", { name: "Resize panes" });
    const frame = await page.locator("[data-split-view]").boundingBox();
    const bar = await divider.boundingBox();
    if (!frame || !bar)
      throw new Error("The split view has no divider to drag.");
    const y = bar.y + bar.height / 2;
    const dragTo = async (x: number) => {
      const from = await divider.boundingBox();
      if (!from) throw new Error("The divider went away.");
      await page.mouse.move(from.x + from.width / 2, y);
      await page.mouse.down();
      await page.mouse.move(x, y, { steps: 8 });
      await page.mouse.up();
    };

    await dragTo(frame.x + frame.width * 0.55);
    await expect(divider).toHaveAttribute("aria-valuenow", "55");
    await expect(page).toHaveURL(/ratio=55/);
    // Within a few pixels of the middle it catches there.
    await dragTo(frame.x + frame.width / 2 + 8);
    await expect(divider).toHaveAttribute("aria-valuenow", "50");

    await divider.focus();
    await page.keyboard.press("ArrowRight");
    await expect(divider).toHaveAttribute("aria-valuenow", "52");
    await page.keyboard.press("End");
    const max = await divider.getAttribute("aria-valuemax");
    await expect(divider).toHaveAttribute("aria-valuenow", max ?? "");
    // Both panes keep a useful width.
    const left = await leftPane(page).boundingBox();
    const right = await rightPane(page).boundingBox();
    expect(left?.width ?? 0).toBeGreaterThan(400);
    expect(right?.width ?? 0).toBeGreaterThan(400);
    await divider.dblclick();
    await expect(divider).toHaveAttribute("aria-valuenow", "50");

    await page.getByRole("button", { name: "Collapse right pane" }).click();
    await expect(page).toHaveURL(/collapsed=right/);
    await expect(entry(rightPane(page), "2025")).toHaveCount(0);
    await page
      .getByRole("button", { name: `Reopen right pane: Archive` })
      .click();
    // The folded pane kept its folder.
    await expect(entry(rightPane(page), "2025")).toBeVisible();
    await expect(page).not.toHaveURL(/collapsed=/);
  });

  test("a pane whose folder is deleted says so, and the other pane goes on working", async ({
    page,
  }) => {
    const { rpc, root } = await seed(page);
    await page.goto(
      `/browse/${root}/Projects?right=${encodeURIComponent(`${root}/Archive/2025`)}&active=left&ratio=50`,
    );
    await expect(
      rightPane(page).getByText("This folder is empty"),
    ).toBeVisible();
    await rpc.files.delete.mutate({ path: `${root}/Archive/2025` });
    await expect(
      rightPane(page).getByRole("alert").getByText("Folder not found"),
    ).toBeVisible();
    await entry(leftPane(page), "Client Alpha").click();
    await expect(
      leftPane(page).getByText("This folder is empty"),
    ).toBeVisible();
    await rightPane(page).getByRole("button", { name: "Open parent" }).click();
    await expect(
      rightPane(page).getByText("This folder is empty"),
    ).toBeVisible();
    await expect(page).toHaveURL(
      new RegExp(`right=${encodeURIComponent(`${root}/Archive`)}&`),
    );
  });
});

test("a split link on a phone shows the active folder and offers the other as a destination", async ({
  page,
  isMobile,
}) => {
  test.skip(!isMobile, "Wide screens show both panes.");
  const { root, names } = await seed(page);
  await page.goto(splitHref(root));
  await expect(page.locator('[data-entry-name="Client Alpha"]')).toBeVisible();
  await expect(page.locator("[data-pane]")).toHaveCount(0);
  const row = page.locator('[data-entry-name="Client Beta"]');
  await row.dispatchEvent("pointerdown", {
    pointerType: "touch",
    isPrimary: true,
  });
  await expect(
    page.getByRole("toolbar", { name: "Selected items" }),
  ).toBeVisible();
  await row.dispatchEvent("pointerup", {
    pointerType: "touch",
    isPrimary: true,
  });
  const bar = page.getByRole("toolbar", { name: "Selected items" });
  await bar.getByRole("button", { name: "Move to Archive" }).click();
  await expect(row).toHaveCount(0);
  expect(await names(`${root}/Archive`)).toContain("Client Beta");
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(page.viewportSize()?.width ?? 0);
});
