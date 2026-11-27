import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, type Locator, type Page } from "@playwright/test";
import { z } from "zod";
import { Device } from "../lib/device";
import {
  action,
  asMember,
  client,
  login,
  origin,
  password,
  test,
} from "./helpers";

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
  await expect(dialog.getByRole("status")).toHaveText(`Already in “${top}”.`);
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

// Every device: phones and tablets take a keyboard too.
test("moves with the keyboard alone, and Escape returns focus to what opened it", async ({
  page,
}) => {
  const { top, names } = await tree({ "notes.txt": "notes" }, [
    "alpha/deep",
    "beta",
  ]);
  await page.goto(href(top));
  const opener = page.getByRole("button", {
    name: "Actions for notes.txt",
    exact: true,
  });
  // The actions button opens a drawer where the pointer is a finger, and a menu elsewhere.
  const coarse = await page.evaluate(
    (query) => matchMedia(query).matches,
    Device.query.coarse,
  );
  const moveItem = coarse
    ? page
        .getByRole("dialog", { name: "notes.txt", exact: true })
        .getByRole("button", { name: "Move to…" })
    : page.getByRole("menuitem", { name: "Move to…" });
  await opener.focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("ArrowDown");
  await expect(moveItem).toBeVisible();
  await moveItem.focus();
  await page.keyboard.press("Enter");
  const dialog = picker(page);
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();

  await page.keyboard.press("Enter");
  await moveItem.focus();
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
  // The report takes focus, inside the picker, where its Undo can be reached.
  await expect(failure).toBeFocused();
  await failure.getByRole("button", { name: "Undo" }).click();
  await expect(failure).toContainText("Moved “a.txt” back to docs.");
  expect(await names("docs")).toEqual(["a.txt"]);
  await writeFile(at("docs/b.txt"), "b again");
  await failure.getByRole("button", { name: "Try again" }).click();
  await expect(dialog).toBeHidden();
  expect(await names("archive")).toEqual(["b.txt"]);
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
      "You can only view “readonly”, so nothing can go there.",
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

test("makes a new folder to move into, and offers starred and recent destinations", async ({
  page,
  context,
  isMobile,
}) => {
  const { top, names } = await tree({ "docs/a.txt": "a", "docs/b.txt": "b" }, [
    "favourite",
  ]);
  await (
    await client(context)
  ).catalog.bookmark.mutate({
    path: `${top}/favourite`,
    starred: true,
  });
  await page.goto(href(`${top}/docs`));
  await action(page, "a.txt", "Move to…", isMobile);
  let dialog = picker(page);
  await dialog.getByRole("button", { name: "Up one folder" }).click();
  await dialog.getByRole("button", { name: "New folder" }).click();
  await dialog.getByLabel("New folder name").fill("made here");
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  // The new folder is opened and becomes the destination.
  await dialog.getByRole("button", { name: "Move to “made here”" }).click();
  await expect(dialog).toBeHidden();
  expect(await names("made here")).toEqual(["a.txt"]);

  await action(page, "b.txt", "Move to…", isMobile);
  dialog = picker(page);
  await dialog.getByRole("button", { name: "Recent", exact: true }).click();
  await expect(folderRow(dialog, `${top}/made here`)).toBeVisible();
  await dialog.getByRole("button", { name: "Starred", exact: true }).click();
  await folderRow(dialog, `${top}/favourite`).click();
  await dialog.getByRole("button", { name: "Move to “favourite”" }).click();
  await expect(dialog).toBeHidden();
  expect(await names("favourite")).toEqual(["b.txt"]);
});

test("reports what moved, with Undo, however a picker with name clashes is closed", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, "Touch multi-selection is covered elsewhere.");
  const { top, names } = await tree({
    "docs/a.txt": "a",
    "docs/b.txt": "mine",
    "archive/b.txt": "theirs",
  });
  const mod = process.platform === "darwin" ? "Meta" : "Control";
  for (const close of ["Escape", "Close", "Cancel"] as const) {
    await page.goto(href(`${top}/docs`));
    for (const item of ["a.txt", "b.txt"])
      await page
        .getByRole("button", { name: item, exact: true })
        .click({ modifiers: [mod] });
    await page
      .getByRole("toolbar", { name: "Selected items" })
      .getByRole("button", { name: "Move", exact: true })
      .click();
    const dialog = picker(page);
    await dialog.getByRole("button", { name: "Up one folder" }).click();
    await folderRow(dialog, `${top}/archive`).click();
    await dialog.getByRole("button", { name: "Move to “archive”" }).click();
    await expect(
      dialog.getByText("“b.txt” is already in archive"),
    ).toBeVisible();
    if (close === "Escape") await page.keyboard.press("Escape");
    else if (close === "Close")
      await dialog.getByRole("button", { name: "Close", exact: true }).click();
    // The picker's own Cancel, below its clash choices.
    else
      await dialog
        .getByRole("button", { name: "Cancel", exact: true })
        .last()
        .click();
    await expect(dialog).toBeHidden();
    // An error toast is announced through its own alert region, so Base UI keeps the toast
    // itself out of the accessibility tree until it has focus: its buttons are found by text.
    const report = page.locator('[data-slot="toast"]').filter({
      hasText: "Moved 1 of 2 items to archive. “b.txt” is already there.",
    });
    await expect(
      report.locator("button", { hasText: "Keep both" }),
    ).toBeVisible();
    await report.locator("button", { hasText: "Undo" }).click();
    await expect.poll(() => names("docs")).toEqual(["a.txt", "b.txt"]);
  }
});

test("never acts on the previous folder's rows while the next one loads", async ({
  page,
  isMobile,
}) => {
  const { top } = await tree({ "notes.txt": "notes" }, [
    "many/inner",
    "archive",
  ]);
  await page.goto(href(top));
  await action(page, "notes.txt", "Move to…", isMobile);
  const dialog = picker(page);
  await expect(folderRow(dialog, `${top}/archive`)).toBeVisible();
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  // Holds the next folder's listing and capability check until released.
  await page.route("**/api/trpc/**", async (route) => {
    if (route.request().url().includes("files.")) await held;
    await route.fallback();
  });
  await folderRow(dialog, `${top}/many`).click();
  // The breadcrumb names "many" at once; the rows still shown are its parent's.
  await expect(dialog.getByText("many", { exact: true }).first()).toBeVisible();
  const stale = dialog.locator('[aria-busy="true"]');
  await expect(stale).toBeVisible();
  await expect(stale).toHaveAttribute("inert", "");
  await expect(
    dialog.getByRole("button", { name: "Move to “many”" }),
  ).toBeDisabled();
  release();
  await expect(folderRow(dialog, `${top}/many/inner`)).toBeVisible();
  await expect(folderRow(dialog, `${top}/archive`)).toHaveCount(0);
  await expect(
    dialog.getByRole("button", { name: "Move to “many”" }),
  ).toBeEnabled();
});

test("keeps the current folder in view in a deep breadcrumb on a phone", async ({
  page,
  isMobile,
}) => {
  test.skip(!isMobile, "Wide screens show the parent folder too.");
  const long = "A rather long ancestor folder name";
  const { top } = await tree({ "notes.txt": "notes" }, [
    `${long} one/${long} two/Current`,
  ]);
  await page.goto(href(top));
  await action(page, "notes.txt", "Move to…", isMobile);
  const dialog = picker(page);
  for (const folder of [
    `${long} one`,
    `${long} one/${long} two`,
    `${long} one/${long} two/Current`,
  ])
    await folderRow(dialog, `${top}/${folder}`).click();
  const current = dialog.locator('[data-slot="breadcrumb-page"]');
  await expect(current).toHaveText("Current");
  const box = await current.boundingBox();
  expect(box?.width ?? 0).toBeGreaterThan(40);
});

/** Opens Files from the picker's places, beside the breadcrumb's own Files. */
const openFiles = (dialog: Locator) =>
  dialog
    .getByRole("navigation", { name: "Places" })
    .filter({ visible: true })
    .getByRole("button", { name: "Files", exact: true })
    .click();

/** The picker's breadcrumb, Up button and footer, read as the person sees them. */
async function pickerRoot(dialog: Locator) {
  return {
    crumbs: await dialog
      .getByRole("navigation", { name: "breadcrumb" })
      .locator('[data-slot="breadcrumb-item"]:visible')
      .allInnerTexts(),
    upDisabled: await dialog
      .getByRole("button", { name: "Up one folder" })
      .isDisabled(),
  };
}

test("roots the picker at Files as each kind of account sees it", async ({
  browser,
  context,
  page,
  isMobile,
}) => {
  const { top } = await tree({ "team/plan.txt": "plan" }, ["team/drafts"]);

  // An administrator's Files is the drive root.
  await page.goto(href(`${top}/team`));
  await action(page, "plan.txt", "Move to…", isMobile);
  let dialog = picker(page);
  await openFiles(dialog);
  await expect(
    dialog.getByText("Destination: Files", { exact: true }),
  ).toBeVisible();
  expect(await pickerRoot(dialog)).toEqual({
    crumbs: ["Files"],
    upDisabled: true,
  });
  await expect(folderRow(dialog, top)).toBeVisible();
  await page.keyboard.press("Escape");

  // A member with a grant outside their home: Files is the drive root, showing the way there.
  const nested = await asMember(browser, context, page, isMobile, [
    { path: `${top}/team`, permission: "write" },
  ]);
  try {
    await nested.member.goto(href(`${top}/team`));
    await action(nested.member, "plan.txt", "Move to…", isMobile);
    dialog = picker(nested.member);
    await expect(
      dialog.getByText(`Destination: Files / ${top} / team`, { exact: true }),
    ).toBeVisible();
    expect((await pickerRoot(dialog)).upDisabled).toBe(false);
    await openFiles(dialog);
    await expect(folderRow(dialog, top)).toBeVisible();
    await expect(dialog.getByRole("status")).toHaveText(
      "You can only view “Files”, so nothing can go there.",
    );
  } finally {
    await nested.memberContext.close();
  }

  // A member limited to their home: Files is the home, and the picker goes no higher.
  const homeOnly = await asMember(browser, context, page, isMobile, []);
  try {
    const home = path.join(await dataRoot(), homeOnly.home);
    await mkdir(path.join(home, "inbox"), { recursive: true });
    await writeFile(path.join(home, "inbox/note.txt"), "note");
    await homeOnly.member.goto(href(`${homeOnly.home}/inbox`));
    await action(homeOnly.member, "note.txt", "Move to…", isMobile);
    dialog = picker(homeOnly.member);
    await expect(
      dialog.getByText("Destination: Files / inbox", { exact: true }),
    ).toBeVisible();
    await openFiles(dialog);
    await expect(
      dialog.getByText("Destination: Files", { exact: true }),
    ).toBeVisible();
    expect(await pickerRoot(dialog)).toEqual({
      crumbs: ["Files"],
      upDisabled: true,
    });
    await expect(folderRow(dialog, `${homeOnly.home}/inbox`)).toBeVisible();
    await dialog.getByRole("button", { name: "Move to “Files”" }).click();
    await expect(dialog).toBeHidden();
    await expect
      .poll(() => readdir(home).then((names) => names.sort()))
      .toContain("note.txt");
  } finally {
    await homeOnly.memberContext.close();
  }
});

test("says which items are already in the destination, and reports them as staying there", async ({
  page,
  context,
  isMobile,
}) => {
  test.skip(isMobile, "Touch multi-selection is covered elsewhere.");
  const { top, names } = await tree({
    "archive/already.txt": "already",
    "docs/incoming.txt": "incoming",
  });
  const rpc = await client(context);
  for (const file of ["archive/already.txt", "docs/incoming.txt"])
    await rpc.catalog.bookmark.mutate({
      path: `${top}/${file}`,
      starred: true,
    });
  await page.goto("/starred");
  const mod = process.platform === "darwin" ? "Meta" : "Control";
  for (const name of ["already.txt", "incoming.txt"])
    await page
      .getByRole("button", { name, exact: true })
      .click({ modifiers: [mod] });
  await page
    .getByRole("toolbar", { name: "Selected items" })
    .getByRole("button", { name: "Move", exact: true })
    .click();
  const dialog = picker(page);
  await dialog.getByRole("button", { name: "Up one folder" }).click();
  await folderRow(dialog, `${top}/archive`).click();
  await expect(dialog.getByRole("status")).toHaveText(
    "1 of 2 items is already in “archive” and stays there.",
  );
  await dialog.getByRole("button", { name: "Move to “archive”" }).click();
  await expect(dialog).toBeHidden();
  await expect(
    page.getByText(
      "Moved “incoming.txt” to archive. “already.txt” was already there.",
    ),
  ).toBeVisible();
  expect(await names("archive")).toEqual(["already.txt", "incoming.txt"]);
});

test("offers no recent or starred folder outside the account's top folder, and never goes above it", async ({
  browser,
  context,
  page,
  isMobile,
}) => {
  const { top } = await tree({}, ["outside/Target"]);
  const rpc = await client(context);
  const account = await asMember(browser, context, page, isMobile, [
    { path: `${top}/outside`, permission: "write" },
  ]);
  try {
    const member = await client(account.memberContext);
    const me = await member.access.me.query();
    await member.files.createFolder.mutate({
      path: account.home,
      name: "Source",
    });
    await member.catalog.bookmark.mutate({
      path: `${top}/outside/Target`,
      starred: true,
    });
    await account.member.goto(href(account.home));
    await account.member.evaluate(
      ({ id, path: target }) =>
        localStorage.setItem(
          `nimbus:recent-destinations:${id}`,
          JSON.stringify([target]),
        ),
      { id: me.id, path: `${top}/outside/Target` },
    );
    // The grant outside the home goes: Files is the home again.
    for (const grant of await rpc.access.permissions.query({
      path: `${top}/outside`,
    }))
      if (grant.subject.type === "user" && grant.subject.id === me.id)
        await rpc.access.revoke.mutate({
          path: `${top}/outside`,
          id: grant.id,
        });
    expect((await member.access.me.query()).top).toBe(account.home);
    await account.member.reload();
    await action(account.member, "Source", "Move to…", isMobile);
    const dialog = picker(account.member);
    await expect(
      dialog.getByRole("button", { name: "Up one folder" }),
    ).toBeDisabled();
    const places = dialog
      .getByRole("navigation", { name: "Places" })
      .filter({ visible: true });
    await places.getByRole("button", { name: "Recent", exact: true }).click();
    await expect(
      dialog.getByText("Folders you move or copy items into show up here."),
    ).toBeVisible();
    await places.getByRole("button", { name: "Starred", exact: true }).click();
    await expect(
      dialog.getByText(
        "No starred folders you can add to. Star a folder to find it here.",
      ),
    ).toBeVisible();
    await expect(folderRow(dialog, `${top}/outside/Target`)).toHaveCount(0);
  } finally {
    await account.memberContext.close();
  }
});

/** Selects `names` in the open folder and opens the picker from the selection bar. */
async function moveSelection(page: Page, names: readonly string[]) {
  const mod = process.platform === "darwin" ? "Meta" : "Control";
  for (const name of names)
    await page
      .getByRole("button", { name, exact: true })
      .click({ modifiers: [mod] });
  await expect(page.getByText(`${names.length} selected`)).toBeVisible();
  await page
    .getByRole("toolbar", { name: "Selected items" })
    .getByRole("button", { name: "Move", exact: true })
    .click();
  return picker(page);
}

/** Opens `folder`, a sibling of the folder the picker shows, and moves there. */
async function moveToSibling(dialog: Locator, top: string, folder: string) {
  await dialog.getByRole("button", { name: "Up one folder" }).click();
  await folderRow(dialog, `${top}/${folder}`).click();
  await dialog.getByRole("button", { name: `Move to “${folder}”` }).click();
}

const toasts = (page: Page) => page.locator('[data-slot="toast"]');

/** Holds every move request until the returned function is called. */
async function holdMoves(page: Page) {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let seen = () => {};
  const requested = new Promise<void>((resolve) => {
    seen = resolve;
  });
  await page.route("**/api/trpc/files.move*", async (route) => {
    seen();
    await held;
    await route.continue();
  });
  return { requested, release };
}

test("moves only what did not arrive when the rest go elsewhere, keeping the earlier move's Undo", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, "Touch multi-selection is covered elsewhere.");
  const { top, names } = await tree(
    { "docs/a.txt": "mine", "docs/b.txt": "b", "archive/a.txt": "theirs" },
    ["elsewhere"],
  );
  await page.goto(href(`${top}/docs`));
  const dialog = await moveSelection(page, ["a.txt", "b.txt"]);
  await moveToSibling(dialog, top, "archive");
  await expect(dialog.getByText("“a.txt” is already in archive")).toBeVisible();
  // Only the item whose name was taken is left to move.
  await expect(
    dialog.getByRole("heading", { name: "Move “a.txt”" }),
  ).toBeVisible();
  await moveToSibling(dialog, top, "elsewhere");
  await expect(dialog).toBeHidden();
  expect(await names("elsewhere")).toEqual(["a.txt"]);
  expect(await names("archive")).toEqual(["a.txt", "b.txt"]);
  // b.txt is still reported, and one Undo puts both back.
  const report = toasts(page).filter({
    hasText: "Moved 2 items to 2 folders.",
  });
  await report.getByRole("button", { name: "Undo" }).click();
  await expect.poll(() => names("docs")).toEqual(["a.txt", "b.txt"]);
});

test("reports a move that finishes after the page changed", async ({
  page,
  isMobile,
}) => {
  const { top, names } = await tree({ "docs/a.txt": "a" }, ["archive"]);
  await page.goto(href(top));
  await page.getByRole("link", { name: "docs", exact: true }).click();
  await action(page, "a.txt", "Move to…", isMobile);
  const dialog = picker(page);
  const moves = await holdMoves(page);
  void moveToSibling(dialog, top, "archive");
  await moves.requested;
  await page.goBack();
  await expect(dialog).toBeHidden();
  // Longer than the picker waits before it reports.
  await page.waitForTimeout(100);
  moves.release();
  await expect.poll(() => names("archive")).toEqual(["a.txt"]);
  const report = toasts(page).filter({
    hasText: "Moved “a.txt” to archive.",
  });
  await report.getByRole("button", { name: "Undo" }).click();
  await expect.poll(() => names("docs")).toEqual(["a.txt"]);
});

test("closes during a move, which reports when it finishes without closing what opened since", async ({
  page,
  isMobile,
}) => {
  const { top, names } = await tree({ "docs/a.txt": "a", "docs/b.txt": "b" }, [
    "archive",
  ]);
  await page.goto(href(`${top}/docs`));
  await action(page, "a.txt", "Move to…", isMobile);
  const dialog = picker(page);
  const moves = await holdMoves(page);
  void moveToSibling(dialog, top, "archive");
  await moves.requested;
  await expect(dialog.getByRole("status")).toContainText(
    "Closing this lets it go on.",
  );
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  // Another picker opened meanwhile stays open when the first move finishes.
  await action(page, "b.txt", "Move to…", isMobile);
  await expect(
    dialog.getByRole("heading", { name: "Move “b.txt”" }),
  ).toBeVisible();
  moves.release();
  await expect.poll(() => names("archive")).toEqual(["a.txt"]);
  await page.waitForTimeout(300);
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await toasts(page)
    .filter({ hasText: "Moved “a.txt” to archive." })
    .getByRole("button", { name: "Undo" })
    .click();
  await expect.poll(() => names("docs")).toEqual(["a.txt", "b.txt"]);
});

test("asks before the page is left while a move is running", async ({
  page,
  isMobile,
}) => {
  const { top } = await tree({ "docs/a.txt": "a" }, ["archive"]);
  await page.goto(href(`${top}/docs`));
  await action(page, "a.txt", "Move to…", isMobile);
  const dialog = picker(page);
  const moves = await holdMoves(page);
  void moveToSibling(dialog, top, "archive");
  await moves.requested;
  const asked = page.waitForEvent("dialog");
  await page.close({ runBeforeUnload: true });
  const prompt = await asked;
  expect(prompt.type()).toBe("beforeunload");
  await prompt.accept();
  moves.release();
});

test("reports a picker that sent items to four folders as one, with one Undo for all of it", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, "Touch multi-selection is covered elsewhere.");
  // Each folder already has the names of the items still to move after the one it takes.
  const { top, names, at } = await tree({
    "docs/a.txt": "a",
    "docs/b.txt": "b",
    "docs/c.txt": "c",
    "docs/d.txt": "d",
    "one/b.txt": "taken",
    "one/c.txt": "taken",
    "one/d.txt": "taken",
    "two/c.txt": "taken",
    "two/d.txt": "taken",
    "three/d.txt": "taken",
    "four/.keep": "",
  });
  await page.goto(href(`${top}/docs`));
  const dialog = await moveSelection(page, [
    "a.txt",
    "b.txt",
    "c.txt",
    "d.txt",
  ]);
  for (const folder of ["one", "two", "three"]) {
    await moveToSibling(dialog, top, folder);
    await expect(dialog.getByRole("alertdialog")).toBeVisible();
  }
  await moveToSibling(dialog, top, "four");
  await expect(dialog).toBeHidden();
  await expect(toasts(page)).toHaveCount(1);
  const report = toasts(page).filter({
    hasText: "Moved 4 items to 4 folders.",
  });
  await expect(report).toBeVisible();
  await report.getByRole("button", { name: "Details" }).click();
  const details = page.getByRole("dialog", { name: "What was moved" });
  for (const line of [
    "Moved “a.txt” to one.",
    "Moved “b.txt” to two.",
    "Moved “c.txt” to three.",
    "Moved “d.txt” to four.",
  ])
    await expect(details).toContainText(line);
  await details
    .getByRole("button", { name: "Close", exact: true })
    .first()
    .click();
  await expect(details).toBeHidden();
  // Changed since, so Undo leaves it and says so.
  await writeFile(at("four/d.txt"), "changed since");
  await toasts(page)
    .filter({ hasText: "Moved 4 items to 4 folders." })
    .getByRole("button", { name: "Undo" })
    .click();
  await expect(
    toasts(page).filter({ hasText: "Moved 3 of 4 items back." }),
  ).toContainText("d.txt");
  expect(await names("docs")).toEqual(["a.txt", "b.txt", "c.txt"]);
  expect(await names("four")).toEqual([".keep", "d.txt"]);
});

test("returns an open picker to the account's top folder when that top narrows", async ({
  browser,
  context,
  page,
  isMobile,
}) => {
  const { top } = await tree({ "docs/a.txt": "a" }, ["archive"]);
  const admin = await client(context);
  const account = await asMember(browser, context, page, isMobile, [
    { path: top, permission: "write" },
  ]);
  try {
    const member = account.member;
    await member.clock.install();
    await member.goto(href(`${top}/docs`));
    await action(member, "a.txt", "Move to…", isMobile);
    const dialog = picker(member);
    await dialog.getByRole("button", { name: "Up one folder" }).click();
    await expect(folderRow(dialog, `${top}/archive`)).toBeVisible();
    const me = await (await client(account.memberContext)).access.me.query();
    for (const grant of await admin.access.permissions.query({ path: top }))
      if (grant.subject.type === "user" && grant.subject.id === me.id)
        await admin.access.revoke.mutate({ path: top, id: grant.id });
    const refreshed = member.waitForResponse((response) =>
      response.url().includes("access.me"),
    );
    await member.clock.fastForward(31_000);
    await member.evaluate(() =>
      window.dispatchEvent(new Event("visibilitychange")),
    );
    expect(await (await refreshed).text()).toContain(
      JSON.stringify(account.home),
    );
    // The picker is back at the new top, with nowhere outside it to go back to.
    await expect(
      dialog.getByText("Destination: Files", { exact: true }),
    ).toBeVisible();
    await expect(folderRow(dialog, `${top}/archive`)).toHaveCount(0);
    await expect(
      dialog.getByRole("button", { name: "Up one folder" }),
    ).toBeDisabled();
    await expect(
      dialog.getByRole("button", { name: "Back", exact: true }),
    ).toBeDisabled();
  } finally {
    await account.memberContext.close();
  }
});
