import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, type Locator, type Page } from "@playwright/test";
import { z } from "zod";
import { action, client, login, origin, password, test } from "./helpers";

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

/** A fresh top folder holding `files` (path to contents) and `folders`. */
async function tree(files: Record<string, string>, folders: string[] = []) {
  const top = `picker-${randomUUID()}`;
  const root = path.join(await dataRoot(), top);
  for (const folder of folders)
    await mkdir(path.join(root, folder), { recursive: true });
  for (const [file, body] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), body);
  }
  await mkdir(root, { recursive: true });
  return {
    top,
    at: (relative: string) => path.join(root, relative),
    names: async (relative = "") =>
      (await readdir(path.join(root, relative))).sort(),
  };
}

const href = (folder: string) =>
  `/browse/${folder.split("/").map(encodeURIComponent).join("/")}`;
const picker = (page: Page) => page.locator("[data-picker]");
const folderRow = (scope: Locator, folder: string) =>
  scope.locator(`[data-folder-path="${folder}"]`);

/** Every element of the picker stays inside it, and the page never scrolls sideways. */
async function expectContained(page: Page) {
  const overflow = await page.evaluate(() => {
    const element = document.querySelector("[data-picker]");
    if (!element) return ["no picker"];
    const box = element.getBoundingClientRect();
    const outside = [...element.querySelectorAll("*")]
      .filter((child) => {
        const rect = child.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return false;
        // Focus rings and hit areas may reach a pixel or two past their row.
        return rect.right > box.right + 2 || rect.left < box.left - 2;
      })
      .map((child) => child.outerHTML.slice(0, 80));
    if (document.documentElement.scrollWidth > window.innerWidth)
      outside.push("page scrolls sideways");
    if (
      box.right > window.innerWidth + 1 ||
      box.bottom > window.innerHeight + 1
    )
      outside.push("picker leaves the viewport");
    return outside;
  });
  expect(overflow).toEqual([]);
}

test.beforeEach(async ({ context, page, isMobile }) => {
  if (!isMobile) await page.setViewportSize({ width: 1440, height: 900 });
  await (
    await client(context)
  ).prefs.set.mutate({
    view: "list",
    sortField: "name",
    sortDirection: "asc",
    groupByType: true,
  });
});

test("opens where the items are, keeps one size, and contains long names", async ({
  page,
  isMobile,
}) => {
  const long = `${"A folder name that keeps going well past any width ".repeat(4).trim()}`;
  const { top } = await tree({ "notes.txt": "notes" }, [`${long}/inner`, "b"]);
  await page.goto(href(top));
  await action(page, "notes.txt", "Move to…", isMobile);
  const dialog = picker(page);
  await expect(dialog).toBeVisible();
  // Measured once the opening animation has finished.
  await page.waitForTimeout(400);
  // It opens in the item's folder, which is where it already is.
  await expect(dialog.getByRole("status")).toHaveText(
    "This item is already here. Choose another folder.",
  );
  await expect(
    dialog.getByRole("button", { name: `Move to “${top}”` }),
  ).toBeDisabled();
  const size = await dialog.boundingBox();
  await expectContained(page);
  await folderRow(dialog, `${top}/${long}`).click();
  await expect(
    dialog.getByRole("button", { name: `Move to “${long}”` }),
  ).toBeEnabled();
  await expectContained(page);
  // Navigating never resizes it: an empty folder keeps the same box.
  await folderRow(dialog, `${top}/${long}/inner`).click();
  await expect(dialog.getByText("No folders here.")).toBeVisible();
  expect(await dialog.boundingBox()).toEqual(size);
  await expectContained(page);
  if (isMobile) {
    const viewport = page.viewportSize();
    expect(size?.height).toBe(viewport?.height);
  } else {
    expect(size).toMatchObject({ width: 760, height: 560 });
  }
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toBeHidden();
});

test("renders a bounded window of a folder with 2,000 folders", async ({
  page,
  isMobile,
}) => {
  const folders = Array.from(
    { length: 2000 },
    (_, index) => `many/Folder ${String(index).padStart(4, "0")}`,
  );
  const { top } = await tree({ "notes.txt": "notes" }, folders);
  await page.goto(href(top));
  await action(page, "notes.txt", "Move to…", isMobile);
  const dialog = picker(page);
  await folderRow(dialog, `${top}/many`).click();
  const list = dialog.getByRole("listbox");
  await expect(folderRow(dialog, `${top}/many/Folder 0000`)).toBeVisible();
  expect(await list.getByRole("option").count()).toBeLessThan(80);
  // The keyboard reaches the end, which renders it.
  await folderRow(dialog, `${top}/many/Folder 0000`).focus();
  await page.keyboard.press("End");
  await expect(folderRow(dialog, `${top}/many/Folder 1999`)).toBeFocused();
  expect(await list.getByRole("option").count()).toBeLessThan(80);
});

test("moves with the keyboard alone, and Escape returns focus to what opened it", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, "Phones have no hardware keyboard.");
  const { top, names } = await tree({ "notes.txt": "notes" }, [
    "alpha/deep",
    "beta",
  ]);
  await page.goto(href(top));
  const opener = page.getByRole("button", {
    name: "Actions for notes.txt",
    exact: true,
  });
  await opener.focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("menuitem", { name: "Move to…" })).toBeVisible();
  await page.getByRole("menuitem", { name: "Move to…" }).focus();
  await page.keyboard.press("Enter");
  const dialog = picker(page);
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();

  await page.keyboard.press("Enter");
  await page.getByRole("menuitem", { name: "Move to…" }).focus();
  await page.keyboard.press("Enter");
  await expect(dialog).toBeVisible();
  // From the search field, Down enters the list; Enter opens a folder.
  await dialog.getByRole("searchbox").focus();
  await page.keyboard.press("ArrowDown");
  await expect(folderRow(dialog, `${top}/alpha`)).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(folderRow(dialog, `${top}/alpha/deep`)).toBeFocused();
  // Alt+Up goes back up and focuses the folder just left.
  await page.keyboard.press("Alt+ArrowUp");
  await expect(folderRow(dialog, `${top}/alpha`)).toBeFocused();
  // Typing a name jumps to it.
  await page.keyboard.type("b");
  await expect(folderRow(dialog, `${top}/beta`)).toBeFocused();
  await page.keyboard.press("Enter");
  // An empty folder has no rows: the move button takes focus.
  const move = dialog.getByRole("button", { name: "Move to “beta”" });
  await expect(move).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(dialog).toBeHidden();
  expect(await names("beta")).toEqual(["notes.txt"]);
});

test("asks about taken names: rename, keep both, skip and cancel never overwrite", async ({
  page,
  isMobile,
}) => {
  const { top, at, names } = await tree({
    "docs/a.txt": "mine a",
    "docs/b.txt": "mine b",
    "archive/a.txt": "theirs a",
    "archive/b.txt": "theirs b",
  });
  const open = async (item: string) => {
    await page.goto(href(`${top}/docs`));
    await action(page, item, "Move to…", isMobile);
    const dialog = picker(page);
    await dialog.getByRole("button", { name: "Up one folder" }).click();
    await folderRow(dialog, `${top}/archive`).click();
    await dialog.getByRole("button", { name: "Move to “archive”" }).click();
    return dialog;
  };

  // Cancel: nothing moves, and the picker stays to choose another folder.
  let dialog = await open("a.txt");
  await expect(dialog.getByText("“a.txt” is already in archive")).toBeVisible();
  await dialog
    .getByRole("button", { name: "Cancel", exact: true })
    .first()
    .click();
  await expect(dialog).toBeVisible();
  expect(await names("docs")).toEqual(["a.txt", "b.txt"]);

  // Rename: the suggested name is free; another can be typed.
  await page.keyboard.press("Escape");
  dialog = await open("a.txt");
  const name = dialog.getByLabel("New name");
  await expect(name).toHaveValue("a (1).txt");
  await name.fill("a from docs.txt");
  await dialog.getByRole("button", { name: "Rename", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(
    page.getByText("Moved “a.txt” to archive as “a from docs.txt”."),
  ).toBeVisible();
  expect(await readFile(at("archive/a from docs.txt"), "utf8")).toBe("mine a");
  expect(await readFile(at("archive/a.txt"), "utf8")).toBe("theirs a");

  // Keep both.
  dialog = await open("b.txt");
  await dialog.getByRole("button", { name: "Keep both" }).click();
  await expect(dialog).toBeHidden();
  expect(await readFile(at("archive/b (1).txt"), "utf8")).toBe("mine b");
  expect(await readFile(at("archive/b.txt"), "utf8")).toBe("theirs b");

  // Skip, for several items.
  if (isMobile) return;
  await writeFile(at("docs/a.txt"), "again a");
  await writeFile(at("docs/b.txt"), "again b");
  await writeFile(at("docs/c.txt"), "c");
  await page.goto(href(`${top}/docs`));
  await page.getByRole("button", { name: "a.txt", exact: true }).click({
    modifiers: [process.platform === "darwin" ? "Meta" : "Control"],
  });
  for (const item of ["b.txt", "c.txt"])
    await page.getByRole("button", { name: item, exact: true }).click({
      modifiers: [process.platform === "darwin" ? "Meta" : "Control"],
    });
  await page
    .getByRole("toolbar", { name: "Selected items" })
    .getByRole("button", { name: "Move", exact: true })
    .click();
  dialog = picker(page);
  await dialog.getByRole("button", { name: "Up one folder" }).click();
  await folderRow(dialog, `${top}/archive`).click();
  await dialog.getByRole("button", { name: "Move to “archive”" }).click();
  await expect(
    dialog.getByText("2 items have names already in archive"),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Skip these" }).click();
  await expect(dialog).toBeHidden();
  await expect(
    page.getByText(
      "Moved 1 item to archive. Skipped 2 items whose names were taken.",
    ),
  ).toBeVisible();
  expect(await names("docs")).toEqual(["a.txt", "b.txt"]);
  expect(await readFile(at("archive/a.txt"), "utf8")).toBe("theirs a");
});

test("keeps the picker open when a move fails, and retries what failed", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, "Touch multi-selection is covered elsewhere.");
  const { top, at, names } = await tree(
    { "docs/a.txt": "a", "docs/b.txt": "b" },
    ["archive"],
  );
  await page.goto(href(`${top}/docs`));
  const mod = process.platform === "darwin" ? "Meta" : "Control";
  await page
    .getByRole("button", { name: "a.txt", exact: true })
    .click({ modifiers: [mod] });
  await page
    .getByRole("button", { name: "b.txt", exact: true })
    .click({ modifiers: [mod] });
  await page
    .getByRole("toolbar", { name: "Selected items" })
    .getByRole("button", { name: "Move", exact: true })
    .click();
  const dialog = picker(page);
  await dialog.getByRole("button", { name: "Up one folder" }).click();
  await folderRow(dialog, `${top}/archive`).click();
  // Removed outside Nimbus after it was listed: that one item fails.
  await rm(at("docs/b.txt"));
  await dialog.getByRole("button", { name: "Move to “archive”" }).click();
  const failure = dialog.getByRole("alert");
  await expect(failure).toContainText(
    "Moved 1 of 2 items to archive. 1 could not be moved:",
  );
  await expect(failure).toContainText("b.txt");
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("heading", { name: "Move “b.txt”" }),
  ).toBeVisible();
  await writeFile(at("docs/b.txt"), "b again");
  await failure.getByRole("button", { name: "Try again" }).click();
  await expect(dialog).toBeHidden();
  expect(await names("archive")).toEqual(["a.txt", "b.txt"]);
  // The retry reports what it moved, with Undo of its own.
  await expect(
    page
      .locator('[data-slot="toast"]')
      .filter({ hasText: "Moved “b.txt” to archive." })
      .getByRole("button", { name: "Undo" }),
  ).toBeVisible();
});

test("undoes moves and copies made from the picker, the selection bar and by dragging", async ({
  page,
  isMobile,
}) => {
  const { top, names } = await tree(
    { "docs/a.txt": "a", "docs/b.txt": "b", "docs/c.txt": "c" },
    ["archive"],
  );
  const undoFromToast = async (message: string, after: string) => {
    const toast = page
      .getByRole("region", { name: "Notifications" })
      .locator('[data-slot="toast"]')
      .filter({ hasText: message });
    await toast.getByRole("button", { name: "Undo" }).click();
    await expect(page.getByText(after)).toBeVisible();
  };
  const toArchive = async (dialog: Locator, verb: "Move" | "Copy") => {
    await dialog.getByRole("button", { name: "Up one folder" }).click();
    await folderRow(dialog, `${top}/archive`).click();
    await dialog.getByRole("button", { name: `${verb} to “archive”` }).click();
    await expect(dialog).toBeHidden();
  };

  // The picker, from an item's menu.
  await page.goto(href(`${top}/docs`));
  await action(page, "a.txt", "Move to…", isMobile);
  await toArchive(picker(page), "Move");
  expect(await names("archive")).toEqual(["a.txt"]);
  await undoFromToast(
    "Moved “a.txt” to archive.",
    "Moved “a.txt” back to docs.",
  );
  expect(await names("docs")).toEqual(["a.txt", "b.txt", "c.txt"]);
  expect(await names("archive")).toEqual([]);

  // A copy goes to trash; the original stays.
  await action(page, "b.txt", "Copy to…", isMobile);
  await toArchive(picker(page), "Copy");
  await undoFromToast(
    "Copied “b.txt” to archive.",
    "Moved the copy “b.txt” to trash.",
  );
  expect(await names("archive")).toEqual([]);
  expect(await names("docs")).toEqual(["a.txt", "b.txt", "c.txt"]);

  if (isMobile) return;
  // The selection bar.
  await page.goto(href(`${top}/docs`));
  await page
    .getByRole("button", { name: "c.txt", exact: true })
    .click({ modifiers: [process.platform === "darwin" ? "Meta" : "Control"] });
  await page
    .getByRole("toolbar", { name: "Selected items" })
    .getByRole("button", { name: "Move", exact: true })
    .click();
  await toArchive(picker(page), "Move");
  await undoFromToast(
    "Moved “c.txt” to archive.",
    "Moved “c.txt” back to docs.",
  );
  expect(await names("docs")).toEqual(["a.txt", "b.txt", "c.txt"]);

  // Dragging onto a folder row.
  await page.goto(href(top));
  await page
    .getByRole("link", { name: "docs", exact: true })
    .dragTo(page.getByRole("link", { name: "archive", exact: true }));
  await expect.poll(() => names("archive")).toEqual(["docs"]);
  await undoFromToast("Moved “docs” to archive.", "Moved “docs” back to");
  expect(await names()).toEqual(["archive", "docs"]);
});

test("shows a member which granted folders take items, and why the others do not", async ({
  browser,
  context,
  page,
  isMobile,
}) => {
  const { top } = await tree(
    { "team/plan.txt": "plan", "readonly/readme.txt": "readme" },
    ["team/drafts", "readonly/inner", "hidden"],
  );
  const email = `picker-${randomUUID()}@nimbus.test`;
  const created = await context.request.post("/api/auth/admin/create-user", {
    headers: { Origin: origin },
    data: { name: "Picker Member", email, password, role: "user" },
  });
  expect(created.ok()).toBe(true);
  const member = z
    .object({ user: z.object({ id: z.string() }) })
    .parse(await created.json()).user.id;
  const rpc = await client(context);
  for (const [folder, permission] of [
    ["team", "write"],
    ["readonly", "read"],
  ] as const)
    await rpc.access.grant.mutate({
      path: `${top}/${folder}`,
      subject: { type: "user", id: member },
      permission,
    });
  const memberContext = await browser.newContext({
    storageState: { cookies: [], origins: [] },
    viewport: page.viewportSize(),
    isMobile,
    hasTouch: isMobile,
  });
  try {
    const memberPage = await memberContext.newPage();
    await login(memberPage, email);
    await memberPage.goto(href(`${top}/team`));
    await action(memberPage, "plan.txt", "Move to…", isMobile);
    const dialog = picker(memberPage);
    await dialog.getByRole("button", { name: "Up one folder" }).click();
    // Only what the member was given is listed.
    await expect(folderRow(dialog, `${top}/hidden`)).toHaveCount(0);
    await expect(folderRow(dialog, `${top}/readonly`)).toContainText(
      "Read-only",
    );
    await expect(folderRow(dialog, `${top}/team`)).toContainText(
      "Already here",
    );
    await folderRow(dialog, `${top}/readonly`).click();
    await expect(dialog.getByRole("status")).toHaveText(
      "You can only view this folder, so this item cannot go here. Open a folder inside it or choose another.",
    );
    await expect(
      dialog.getByRole("button", { name: "Move to “readonly”" }),
    ).toBeDisabled();
    await dialog.getByRole("button", { name: "Up one folder" }).click();
    await folderRow(dialog, `${top}/team`).click();
    await folderRow(dialog, `${top}/team/drafts`).click();
    await dialog.getByRole("button", { name: "Move to “drafts”" }).click();
    await expect(dialog).toBeHidden();
    // Search finds only folders the member can add to.
    await memberPage.goto(href(`${top}/team/drafts`));
    await action(memberPage, "plan.txt", "Copy to…", isMobile);
    const search = picker(memberPage).getByRole("searchbox");
    await search.fill("drafts");
    await expect(
      folderRow(picker(memberPage), `${top}/team/drafts`),
    ).toBeVisible();
    await search.fill("inner");
    await expect(
      picker(memberPage).getByText("No folder you can add to matches “inner”."),
    ).toBeVisible();
  } finally {
    await memberContext.close();
  }
});
