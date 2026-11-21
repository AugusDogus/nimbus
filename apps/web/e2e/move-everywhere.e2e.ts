import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, type Locator, type Page } from "@playwright/test";
import { z } from "zod";
import { client, test } from "./helpers";

/**
 * Every way of moving an item ends the same way: one report with Undo, and when a name is
 * taken, the same choices (rename, keep both, skip) in the picker, opened at the destination.
 */

async function dataRoot() {
  const manifest: unknown = JSON.parse(
    await readFile(
      path.join(
        os.tmpdir(),
        `nimbus-e2e-${process.env.NIMBUS_E2E_PORT ?? "3100"}.json`,
      ),
      "utf8",
    ),
  );
  return z
    .object({ dataRoot: z.string().startsWith(os.tmpdir()) })
    .parse(manifest).dataRoot;
}

/**
 * `top/one/two`, shown at 1440 px as Files › … › one › two, with `files` (paths below `top`,
 * to contents) and the folder `two/dest`.
 */
async function nested(files: Record<string, string>) {
  const top = `everywhere-${randomUUID()}`;
  const root = path.join(await dataRoot(), top);
  await mkdir(path.join(root, "one/two/dest"), { recursive: true });
  for (const [file, body] of Object.entries(files))
    await writeFile(path.join(root, file), body);
  return {
    top,
    current: `${top}/one/two`,
    names: async (relative: string) =>
      (await readdir(path.join(root, relative))).sort(),
    read: (relative: string) => readFile(path.join(root, relative), "utf8"),
  };
}

const href = (folder: string) =>
  `/browse/${folder.split("/").map(encodeURIComponent).join("/")}`;
const row = (page: Page, name: string) =>
  page
    .getByRole("button", { name, exact: true })
    .or(page.getByRole("link", { name, exact: true }));
const trail = (page: Page) => page.locator('nav[aria-label="breadcrumb"]');
const picker = (page: Page) => page.locator("[data-picker]");
const mod = process.platform === "darwin" ? "Meta" : "Control";

/**
 * Presses on `source` and moves a little, which starts the drag; a selection bar over the
 * breadcrumb steps aside then.
 */
async function startDrag(page: Page, source: Locator) {
  await source.first().hover();
  await page.mouse.down();
  const box = await source.first().boundingBox();
  if (!box) throw new Error("The item to drag is not on screen.");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 30, {
    steps: 4,
  });
  await expect(
    page.getByRole("toolbar", { name: "Selected items" }),
  ).toBeHidden();
}

/** Drags `source` over `target` with the mouse and drops it there. */
async function dragOnto(page: Page, source: Locator, target: Locator) {
  await startDrag(page, source);
  await target.hover();
  await target.hover();
  await page.mouse.up();
}

/** Drags `source` onto the folder `name` that the breadcrumb hides behind …. */
async function dragOntoHidden(page: Page, source: Locator, name: string) {
  await startDrag(page, source);
  const more = trail(page).getByRole("button", {
    name: "Show folders in this path",
  });
  await more.hover();
  await more.hover();
  const hidden = page.getByRole("menuitem", { name, exact: true });
  await hidden.hover();
  await hidden.hover();
  await expect(hidden).toHaveAttribute("data-drop-target", "true");
  await page.mouse.up();
}

/** Selects `names` in the listing. */
async function select(page: Page, names: readonly string[]) {
  for (const name of names)
    await row(page, name)
      .first()
      .click({ modifiers: [mod] });
}

/** Undoes the report that says `message`, and waits for the report of the undo. */
async function undo(page: Page, message: string, after: string) {
  // Reports stack, the newest in front: hovering them spreads them out.
  await page.locator('[data-slot="toast"]').first().hover();
  await page
    .locator('[data-slot="toast"]')
    .filter({ hasText: message })
    .getByRole("button", { name: "Undo" })
    .click();
  await expect(page.getByText(after)).toBeVisible();
}

/** Moves the item up from its actions menu, its right-click menu, or the selection bar. */
const moveUp = {
  async menu(page: Page, name: string) {
    await page
      .getByRole("button", { name: `Actions for ${name}`, exact: true })
      .click();
    await page.getByRole("menuitem", { name: "Move up one level" }).click();
  },
  async context(page: Page, name: string) {
    await row(page, name).first().click({ button: "right" });
    await page.getByRole("menuitem", { name: "Move up one level" }).click();
  },
  async bar(page: Page, names: readonly string[]) {
    await select(page, names);
    await page
      .getByRole("toolbar", { name: "Selected items" })
      .getByRole("button", { name: "Move up one level" })
      .click();
  },
} as const;

test.describe("every way of moving", () => {
  test.skip(
    ({ isMobile }) => isMobile,
    "Drags, right-click menus and the selection bar's Move up need a mouse and a wide window.",
  );
  test.beforeEach(async ({ context, page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await (
      await client(context)
    ).prefs.set.mutate({
      view: "list",
      sortField: "name",
      sortDirection: "asc",
      groupByType: true,
    });
  });

  test("moves and undoes by a drop on a folder row, a breadcrumb folder, and one behind …", async ({
    page,
  }) => {
    const { top, current, names } = await nested({
      "one/two/row.txt": "row",
      "one/two/crumb.txt": "crumb",
      "one/two/hidden.txt": "hidden",
    });
    await page.goto(href(current));

    await dragOnto(page, row(page, "row.txt"), row(page, "dest"));
    await expect.poll(() => names("one/two/dest")).toEqual(["row.txt"]);
    await undo(
      page,
      "Moved “row.txt” to dest.",
      "Moved “row.txt” back to two.",
    );
    expect(await names("one/two/dest")).toEqual([]);

    await dragOnto(
      page,
      row(page, "crumb.txt"),
      trail(page).getByRole("link", { name: "one", exact: true }),
    );
    await expect.poll(() => names("one")).toContain("crumb.txt");
    await undo(
      page,
      "Moved “crumb.txt” to one.",
      "Moved “crumb.txt” back to two.",
    );
    expect(await names("one/two")).toContain("crumb.txt");

    await dragOntoHidden(page, row(page, "hidden.txt"), top);
    await expect.poll(() => names("")).toContain("hidden.txt");
    await undo(
      page,
      `Moved “hidden.txt” to ${top}.`,
      "Moved “hidden.txt” back to two.",
    );
    expect(await names("one/two")).toContain("hidden.txt");
  });

  test("offers rename, keep both and skip when a drop finds a name taken", async ({
    page,
  }) => {
    const drive = await nested({
      "one/two/a.txt": "mine a",
      "one/two/dest/a.txt": "theirs a",
      "one/two/b.txt": "mine b",
      "one/b.txt": "theirs b",
      "one/two/c.txt": "mine c",
      "one/two/d.txt": "mine d",
      "c.txt": "theirs c",
      "d.txt": "theirs d",
    });
    await page.goto(href(drive.current));

    // A folder row: keep both.
    await dragOnto(page, row(page, "a.txt"), row(page, "dest"));
    let dialog = picker(page);
    await expect(dialog.getByText("“a.txt” is already in dest")).toBeVisible();
    await dialog.getByRole("button", { name: "Keep both" }).click();
    await expect(dialog).toBeHidden();
    expect(await drive.read("one/two/dest/a (1).txt")).toBe("mine a");
    await undo(
      page,
      "Moved “a.txt” to dest as “a (1).txt”.",
      "Moved “a.txt” back to two.",
    );

    // A breadcrumb folder: rename.
    await dragOnto(
      page,
      row(page, "b.txt"),
      trail(page).getByRole("link", { name: "one", exact: true }),
    );
    dialog = picker(page);
    await dialog.getByLabel("New name").fill("b from two.txt");
    await dialog.getByRole("button", { name: "Rename", exact: true }).click();
    await expect(dialog).toBeHidden();
    expect(await drive.read("one/b from two.txt")).toBe("mine b");
    expect(await drive.read("one/b.txt")).toBe("theirs b");

    // A folder behind …, with a selection whose names are all taken: skip them.
    await select(page, ["c.txt", "d.txt"]);
    await dragOntoHidden(page, row(page, "c.txt"), drive.top);
    dialog = picker(page);
    await expect(
      dialog.getByText(`2 items have names already in ${drive.top}`),
    ).toBeVisible();
    await dialog.getByRole("button", { name: "Skip these" }).click();
    await expect(dialog).toBeHidden();
    await expect(
      page.getByText(
        `Nothing was moved to ${drive.top}. Skipped 2 items whose names were taken.`,
      ),
    ).toBeVisible();
    expect(await drive.names("one/two")).toEqual(
      expect.arrayContaining(["c.txt", "d.txt"]),
    );
    expect(await drive.read("c.txt")).toBe("theirs c");
  });

  test("moves up one level from the item menu, the right-click menu and the selection bar, with Undo", async ({
    page,
  }) => {
    const drive = await nested({
      "one/two/menu.txt": "menu",
      "one/two/context.txt": "context",
      "one/two/bar one.txt": "bar one",
      "one/two/bar two.txt": "bar two",
    });
    await page.goto(href(drive.current));

    await moveUp.menu(page, "menu.txt");
    await expect.poll(() => drive.names("one")).toContain("menu.txt");
    await undo(
      page,
      "Moved “menu.txt” to one.",
      "Moved “menu.txt” back to two.",
    );

    await moveUp.context(page, "context.txt");
    await expect.poll(() => drive.names("one")).toContain("context.txt");
    await undo(
      page,
      "Moved “context.txt” to one.",
      "Moved “context.txt” back to two.",
    );

    await moveUp.bar(page, ["bar one.txt", "bar two.txt"]);
    await expect
      .poll(() => drive.names("one"))
      .toEqual(expect.arrayContaining(["bar one.txt", "bar two.txt"]));
    await undo(page, "Moved 2 items to one.", "Moved 2 items back to two.");
    expect(await drive.names("one/two")).toEqual(
      expect.arrayContaining(["bar one.txt", "bar two.txt", "menu.txt"]),
    );
  });

  test("offers the same choices when moving up one level finds a name taken", async ({
    page,
  }) => {
    const drive = await nested({
      "one/two/menu.txt": "mine",
      "one/menu.txt": "theirs",
      "one/two/context.txt": "mine",
      "one/context.txt": "theirs",
      "one/two/x.txt": "mine x",
      "one/two/y.txt": "mine y",
      "one/x.txt": "theirs x",
      "one/y.txt": "theirs y",
    });
    await page.goto(href(drive.current));

    await moveUp.menu(page, "menu.txt");
    let dialog = picker(page);
    await dialog.getByRole("button", { name: "Keep both" }).click();
    await expect(dialog).toBeHidden();
    expect(await drive.read("one/menu (1).txt")).toBe("mine");

    await moveUp.context(page, "context.txt");
    dialog = picker(page);
    await dialog.getByLabel("New name").fill("context moved.txt");
    await dialog.getByRole("button", { name: "Rename", exact: true }).click();
    await expect(dialog).toBeHidden();
    expect(await drive.read("one/context moved.txt")).toBe("mine");

    await moveUp.bar(page, ["x.txt", "y.txt"]);
    dialog = picker(page);
    await dialog.getByRole("button", { name: "Skip these" }).click();
    await expect(dialog).toBeHidden();
    expect(await drive.read("one/x.txt")).toBe("theirs x");
    expect(await drive.names("one/two")).toEqual(
      expect.arrayContaining(["x.txt", "y.txt"]),
    );
  });

  test("reports every destination a clash picker sent items to, each with its own Undo", async ({
    page,
  }) => {
    const drive = await nested({
      "one/two/a.txt": "mine a",
      "one/two/b.txt": "b",
      "one/a.txt": "theirs a",
    });
    await mkdir(path.join(await dataRoot(), drive.top, "one/elsewhere"));
    await page.goto(href(drive.current));
    await moveUp.bar(page, ["a.txt", "b.txt"]);
    const dialog = picker(page);
    await expect(dialog.getByText("“a.txt” is already in one")).toBeVisible();
    // Choosing another folder for the clashing item, instead of deciding here.
    await dialog.getByRole("button", { name: "Up one folder" }).click();
    await dialog.locator(`[data-folder-path="${drive.top}/one"]`).click();
    await dialog
      .locator(`[data-folder-path="${drive.top}/one/elsewhere"]`)
      .click();
    await dialog.getByRole("button", { name: "Move to “elsewhere”" }).click();
    await expect(dialog).toBeHidden();
    await undo(page, "Moved “b.txt” to one.", "Moved “b.txt” back to two.");
    await undo(
      page,
      "Moved “a.txt” to elsewhere.",
      "Moved “a.txt” back to two.",
    );
    expect(await drive.names("one/two")).toEqual(
      expect.arrayContaining(["a.txt", "b.txt"]),
    );
  });

  test("reports a failure and a clash left open when the clash picker is closed", async ({
    page,
  }) => {
    const drive = await nested({
      "one/two/a.txt": "mine a",
      "one/two/b.txt": "gone",
      "one/a.txt": "theirs a",
    });
    await page.goto(href(drive.current));
    await select(page, ["a.txt", "b.txt"]);
    // Removed outside Nimbus as the move starts: moving it fails.
    const gone = path.join(await dataRoot(), drive.top, "one/two/b.txt");
    await page.route("**/api/trpc/files.move*", async (route) => {
      await rm(gone, { force: true });
      await route.fallback();
    });
    await page
      .getByRole("toolbar", { name: "Selected items" })
      .getByRole("button", { name: "Move up one level" })
      .click();
    const dialog = picker(page);
    await expect(dialog.getByText("“a.txt” is already in one")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    const report = page
      .locator('[data-slot="toast"]')
      .filter({ hasText: "Nothing was moved to one." });
    await expect(report).toContainText("“a.txt” is already there.");
    await expect(report).toContainText("“b.txt”:");
    await expect(
      report.locator("button", { hasText: "Keep both" }),
    ).toBeVisible();
  });
});
