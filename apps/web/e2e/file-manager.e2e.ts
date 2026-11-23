import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, type Page } from "@playwright/test";
import { unzipSync, strFromU8 } from "fflate";
import { z } from "zod";
import { client, test, whenCanCreate } from "./helpers";
import { FileListing } from "@nimbus/api/file-listing";

const mod = process.platform === "darwin" ? "Meta" : "Control";

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

async function folderWithFiles(names: string[]) {
  const folder = `manager-${randomUUID()}`;
  const directory = path.join(await dataRoot(), folder);
  await mkdir(directory);
  for (const name of names)
    await writeFile(path.join(directory, name), `Contents of ${name}`);
  return { folder, directory };
}

const entry = (page: Page, name: string) =>
  page.locator(`[data-entry-name="${name}"]`);
const bar = (page: Page) =>
  page.getByRole("toolbar", { name: "Selected items" });

test.beforeEach(async ({ context }) => {
  await (
    await client(context)
  ).prefs.set.mutate({
    view: "list",
    sortField: "name",
    sortDirection: "asc",
    groupByType: true,
  });
});

test("selects with the mouse and keyboard, then downloads one ZIP and trashes the selection", async ({
  page,
  context,
  isMobile,
}) => {
  test.skip(isMobile, "Touch selection is covered separately.");
  const names = ["a.txt", "b.txt", "c.txt", "d.txt"];
  const { folder } = await folderWithFiles(names);
  await page.goto(`/browse/${folder}`);
  await entry(page, "a.txt").click({ modifiers: [mod] });
  await expect(bar(page)).toContainText("1 selected");
  await entry(page, "c.txt").click({ modifiers: ["Shift"] });
  await expect(bar(page)).toContainText("3 selected");
  await expect(page.getByRole("row", { selected: true })).toHaveCount(3);
  // Selecting never moves the entries: the bar overlays the toolbar.
  const before = await entry(page, "d.txt").boundingBox();
  await entry(page, "d.txt").click({ modifiers: [mod] });
  expect(await entry(page, "d.txt").boundingBox()).toEqual(before);

  const downloadPromise = page.waitForEvent("download");
  await bar(page).getByRole("button", { name: "Download" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe(`${folder}.zip`);
  const file = await download.path();
  if (file === null)
    throw new Error("The browser did not save the ZIP download.");
  const archive = unzipSync(new Uint8Array(await readFile(file)));
  expect(Object.keys(archive).sort()).toEqual(names);
  expect(strFromU8(archive["d.txt"] ?? new Uint8Array())).toBe(
    "Contents of d.txt",
  );

  await page.keyboard.press("Escape");
  await expect(bar(page)).toHaveCount(0);
  await entry(page, "a.txt").focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Shift+ArrowDown");
  await expect(entry(page, "c.txt")).toBeFocused();
  await expect(bar(page)).toContainText("2 selected");
  await page.keyboard.press("Delete");
  const dialog = page.getByRole("alertdialog", { name: "Move to trash?" });
  await expect(dialog).toContainText("2 items");
  await dialog.getByRole("button", { name: "Move to trash" }).click();
  await expect(entry(page, "b.txt")).toHaveCount(0);
  await expect(entry(page, "c.txt")).toHaveCount(0);
  expect(
    FileListing.entries(
      await (await client(context)).files.list.query({ path: folder }),
    )
      .map((item) => item.name)
      .sort(),
  ).toEqual(["a.txt", "d.txt"]);
});

test("navigates with arrows, type-ahead, select all, rename, and the shortcut sheet", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, "Hardware keyboard shortcuts are a desktop feature.");
  const { folder } = await folderWithFiles([
    "alpha.txt",
    "beta.txt",
    "bravo.txt",
    "charlie.txt",
  ]);
  await page.goto(`/browse/${folder}`);
  const grid = page.getByRole("grid", { name: folder });
  await expect(grid).toHaveAttribute("aria-multiselectable", "true");
  await entry(page, "alpha.txt").focus();
  await page.keyboard.press("End");
  await expect(entry(page, "charlie.txt")).toBeFocused();
  await page.keyboard.type("b");
  await expect(entry(page, "beta.txt")).toBeFocused();
  await page.keyboard.type("b");
  await expect(entry(page, "bravo.txt")).toBeFocused();
  await expect(entry(page, "bravo.txt")).toHaveAttribute("tabindex", "0");
  await expect(entry(page, "alpha.txt")).toHaveAttribute("tabindex", "-1");
  await page.keyboard.press(`${mod}+a`);
  await expect(bar(page)).toContainText("4 selected");
  await page.keyboard.press("Escape");
  await page.keyboard.press("F2");
  const rename = page.getByRole("dialog", { name: "Rename" });
  await rename.getByRole("textbox").fill("renamed.txt");
  await rename.getByRole("button", { name: "Rename" }).click();
  await expect(entry(page, "renamed.txt")).toBeVisible();
  await entry(page, "renamed.txt").focus();
  await page.keyboard.press("?");
  await expect(
    page.getByRole("dialog", { name: "Keyboard shortcuts" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  // Closing the sheet returns focus to the entry that opened it.
  await expect(entry(page, "renamed.txt")).toBeFocused();
  await page.keyboard.press(" ");
  await expect(page.getByRole("dialog", { name: "renamed.txt" })).toBeVisible();
});

test("keeps what is selected in the rename field when focus comes back to it", async ({
  page,
}) => {
  const { folder } = await folderWithFiles(["a.txt", "b.txt"]);
  await page.goto(`/browse/${folder}`);
  await entry(page, "b.txt").focus();
  await page.keyboard.press("F2");
  const rename = page.getByRole("dialog", { name: "Rename" });
  const field = rename.getByLabel("Name");
  await expect(field).toBeFocused();
  await page.keyboard.press(`${mod}+a`);
  // Focus can leave and come back while the dialog opens, such as when the menu that opened it
  // hands focus back late. It must not narrow the selection to the name without its extension.
  await field.evaluate((input) => {
    if (!(input instanceof HTMLInputElement)) return;
    input.blur();
    input.focus();
  });
  await page.keyboard.type("a.txt");
  await expect(field).toHaveValue("a.txt");
  await rename.getByRole("button", { name: "Rename", exact: true }).click();
  await expect(rename.getByRole("alert")).toContainText(
    "An item with that name already exists.",
  );
});

test("copies a file into another folder and beside itself", async ({
  page,
  context,
  isMobile,
}) => {
  const { folder, directory } = await folderWithFiles(["report.txt"]);
  await mkdir(path.join(directory, "archive"));
  await page.goto(`/browse/${folder}`);
  await page
    .getByRole("button", { name: "Actions for report.txt", exact: true })
    .click();
  await page
    .getByRole(isMobile ? "button" : "menuitem", {
      name: "Copy to…",
      exact: true,
    })
    .click();
  // The picker opens in the item's own folder, where a copy gets a numbered name.
  const dialog = page.getByRole("dialog", { name: "Copy “report.txt”" });
  await dialog.getByRole("button", { name: `Copy to “${folder}”` }).click();
  await expect(dialog).toBeHidden();
  await expect(
    page.getByText(`Copied “report.txt” to ${folder} as “report (1).txt”.`),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Actions for report.txt", exact: true })
    .click();
  await page
    .getByRole(isMobile ? "button" : "menuitem", {
      name: "Copy to…",
      exact: true,
    })
    .click();
  await dialog.locator(`[data-folder-path="${folder}/archive"]`).click();
  await dialog.getByRole("button", { name: "Copy to “archive”" }).click();
  const rpc = await client(context);
  await expect
    .poll(async () =>
      FileListing.entries(await rpc.files.list.query({ path: folder }))
        .map((item) => item.name)
        .sort(),
    )
    .toEqual(["archive", "report (1).txt", "report.txt"]);
  await expect
    .poll(async () =>
      FileListing.entries(
        await rpc.files.list.query({ path: `${folder}/archive` }),
      ).map((item) => item.name),
    )
    .toEqual(["report.txt"]);
});

test("asks about name clashes when uploading, replacing or keeping both", async ({
  page,
  context,
}) => {
  const { folder } = await folderWithFiles(["notes.txt"]);
  await page.goto(`/browse/${folder}`);
  await whenCanCreate(page);
  const input = page.locator('input[type="file"]');
  await input.setInputFiles({
    name: "notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Replaced"),
  });
  const clash = page.getByRole("dialog", {
    name: "A file named “notes.txt” already exists",
  });
  await clash.getByRole("button", { name: "Replace" }).click();
  const read = async (name: string) =>
    (
      await context.request.get(
        `/api/files/download?path=${encodeURIComponent(`${folder}/${name}`)}`,
      )
    ).text();
  await expect.poll(() => read("notes.txt")).toBe("Replaced");
  await input.setInputFiles({
    name: "notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Second copy"),
  });
  await clash.getByRole("button", { name: "Keep both" }).click();
  await expect(entry(page, "notes (1).txt")).toBeVisible();
  expect(await read("notes (1).txt")).toBe("Second copy");
  await input.setInputFiles({
    name: "notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Skipped"),
  });
  await clash.getByRole("button", { name: "Skip" }).click();
  await expect(clash).toBeHidden();
  expect(await read("notes.txt")).toBe("Replaced");
});

test("uploads a folder from the folder picker, preserving its structure", async ({
  page,
  context,
  isMobile,
}) => {
  const { folder } = await folderWithFiles([]);
  const local = await mkdtemp(path.join(os.tmpdir(), "nimbus-folder-upload-"));
  try {
    await mkdir(path.join(local, "trip", "day 1"), { recursive: true });
    await writeFile(path.join(local, "trip", "plan.txt"), "Plan");
    await writeFile(path.join(local, "trip", "day 1", "photo.txt"), "Photo");
    await page.goto(`/browse/${folder}`);
    const chooser = page.waitForEvent("filechooser");
    await page
      .getByRole("button", {
        name: isMobile ? "New file or folder" : "New",
        exact: true,
      })
      .click();
    await page
      .getByRole(isMobile ? "button" : "menuitem", {
        name: "Upload folder",
        exact: true,
      })
      .click();
    await (await chooser).setFiles(path.join(local, "trip"));
    await expect(
      page.getByRole("link", { name: "trip", exact: true }),
    ).toBeVisible();
    const rpc = await client(context);
    await expect
      .poll(async () =>
        FileListing.entries(
          await rpc.files.list.query({ path: `${folder}/trip/day 1` }),
        ).map((item) => item.name),
      )
      .toEqual(["photo.txt"]);
    expect(
      FileListing.entries(
        await rpc.files.list.query({ path: `${folder}/trip` }),
      )
        .map((item) => item.name)
        .sort(),
    ).toEqual(["day 1", "plan.txt"]);
  } finally {
    await rm(local, { recursive: true, force: true });
  }
});

test("renders large folders as a window and keeps keyboard focus and scroll position", async ({
  page,
  context,
  isMobile,
}) => {
  // Without grouping, the folder sorts last, below 2,000 files.
  await (
    await client(context)
  ).prefs.set.mutate({
    view: "list",
    sortField: "name",
    sortDirection: "asc",
    groupByType: false,
  });
  const names = Array.from(
    { length: 2000 },
    (_, index) => `item ${String(index).padStart(4, "0")}.txt`,
  );
  const { folder, directory } = await folderWithFiles(names);
  await mkdir(path.join(directory, "zz child"));
  await page.goto(`/browse/${folder}`);
  await expect(entry(page, "item 0000.txt")).toBeVisible();
  expect(await page.locator("[data-entry-name]").count()).toBeLessThan(150);
  await expect(page.getByRole("grid", { name: folder })).toHaveAttribute(
    "aria-rowcount",
    "2001",
  );
  const last = entry(page, "zz child");
  const scroller = page.locator('[data-slot="sidebar-inset"]');
  if (isMobile)
    await scroller.evaluate((element) =>
      element.scrollTo(0, element.scrollHeight),
    );
  else {
    await entry(page, "item 0000.txt").focus();
    await page.keyboard.press("End");
    await expect(last).toBeFocused();
  }
  await expect(last).toBeInViewport();
  await expect(page.getByRole("row").filter({ has: last })).toHaveAttribute(
    "aria-rowindex",
    "2001",
  );
  await expect(entry(page, "item 0000.txt")).toHaveCount(0);
  const saved = await scroller.evaluate((element) => element.scrollTop);
  expect(saved).toBeGreaterThan(50_000);
  // Opening a folder starts it at the top; returning restores where the list was.
  await last.click();
  await expect(page).toHaveURL(
    `/browse/${folder}/${encodeURIComponent("zz child")}`,
  );
  await expect(
    page.getByRole("heading", { name: "This folder is empty" }),
  ).toBeVisible();
  expect(await scroller.evaluate((element) => element.scrollTop)).toBe(0);
  await page.goBack();
  await expect(last).toBeInViewport();
  // Within one row: a position saved at the very bottom is clamped if the header height differs.
  expect(
    Math.abs((await scroller.evaluate((element) => element.scrollTop)) - saved),
  ).toBeLessThan(52);
});

test("long-press starts selection mode on touch, and taps then toggle items", async ({
  page,
  isMobile,
}) => {
  test.skip(!isMobile, "Touch selection applies to touch screens.");
  const { folder } = await folderWithFiles(["one.txt", "two.txt", "three.txt"]);
  await page.goto(`/browse/${folder}`);
  const target = entry(page, "one.txt");
  // Server-rendered rows show before the page hydrates and are draggable until the touch layout
  // applies. A press before then never reaches the long-press handler.
  await expect(target).toHaveAttribute("draggable", "false");
  // A stationary press: only the distance between pointer events matters, not where they land.
  const point = {
    clientX: 100,
    clientY: 100,
    pointerType: "touch",
    isPrimary: true,
    button: 0,
  };
  await target.dispatchEvent("pointerdown", point);
  await page.waitForTimeout(600);
  await target.dispatchEvent("pointerup", point);
  await target.dispatchEvent("click", point);
  await expect(bar(page)).toContainText("1 selected");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await entry(page, "two.txt").tap();
  await expect(bar(page)).toContainText("2 selected");
  await bar(page).getByRole("button", { name: "Clear selection" }).click();
  await expect(bar(page)).toHaveCount(0);
});

test("rows keep their elements through hydration and across the breakpoint, so a press on the first one shown selects", async ({
  page,
  isMobile,
}) => {
  test.skip(!isMobile, "The touch layout applies after hydration on phones.");
  const { folder } = await folderWithFiles(["one.txt", "two.txt"]);
  // Remember the first element shown for the row, as a finger resting on it would. Streamed
  // content waits in hidden containers until it is revealed.
  await page.addInitScript(() => {
    const observer = new MutationObserver(() => {
      const row = [
        ...document.querySelectorAll('[data-entry-name="one.txt"]'),
      ].find((element) => !element.closest("[hidden]"));
      if (!row) return;
      Reflect.set(window, "firstRow", row);
      observer.disconnect();
    });
    observer.observe(document, { childList: true, subtree: true });
  });
  await page.goto(`/browse/${folder}`);
  const target = entry(page, "one.txt");
  const isFirstRow = () =>
    target.evaluate((element) => element === Reflect.get(window, "firstRow"));
  // The phone layout shows its own New button; touch alone never drags, at any width.
  const phoneNew = page.getByRole("button", { name: "New file or folder" });
  await expect(phoneNew).toBeVisible();
  await expect(target).toHaveAttribute("draggable", "false");
  expect(await isFirstRow()).toBe(true);
  const viewport = page.viewportSize();
  if (!viewport) throw new Error("The mobile project has no viewport size.");
  await page.setViewportSize({ width: 900, height: viewport.height });
  await expect(phoneNew).toBeHidden();
  await expect(target).toHaveAttribute("draggable", "false");
  expect(await isFirstRow()).toBe(true);
  await page.setViewportSize(viewport);
  await expect(phoneNew).toBeVisible();
  expect(await isFirstRow()).toBe(true);

  const press = (type: "pointerdown" | "pointerup" | "click") =>
    page.evaluate((type) => {
      const row: unknown = Reflect.get(window, "firstRow");
      if (!(row instanceof HTMLElement))
        throw new Error("The row was never shown.");
      const point = {
        bubbles: true,
        cancelable: true,
        clientX: 100,
        clientY: 100,
        pointerType: "touch",
        isPrimary: true,
      };
      row.dispatchEvent(
        type === "click"
          ? new MouseEvent(type, point)
          : new PointerEvent(type, point),
      );
    }, type);
  await press("pointerdown");
  await page.waitForTimeout(600);
  await press("pointerup");
  await press("click");
  await expect(bar(page)).toContainText("1 selected");
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("empties trash in one step after confirmation", async ({
  page,
  context,
}) => {
  const rpc = await client(context);
  const { folder } = await folderWithFiles(["gone-1.txt", "gone-2.txt"]);
  await rpc.files.delete.mutate({ path: `${folder}/gone-1.txt` });
  await rpc.files.delete.mutate({ path: `${folder}/gone-2.txt` });
  await page.goto("/trash");
  await page.getByRole("button", { name: "Empty trash", exact: true }).click();
  const dialog = page.getByRole("alertdialog", { name: "Empty trash?" });
  await expect(dialog).toContainText("including items other people deleted");
  await dialog.getByRole("button", { name: "Empty trash" }).click();
  await expect(page.getByText("Trash is empty.")).toBeVisible();
  expect(await rpc.trash.list.query()).toEqual([]);
  await expect(
    page.getByRole("button", { name: "Empty trash", exact: true }),
  ).toHaveCount(0);
});

test("Tab reaches an entry on screen after scrolling a long folder", async ({
  page,
  context,
  isMobile,
}) => {
  test.skip(isMobile, "Keyboard navigation is a desktop interaction.");
  await (
    await client(context)
  ).prefs.set.mutate({
    view: "list",
    sortField: "name",
    sortDirection: "asc",
    groupByType: false,
  });
  const names = Array.from(
    { length: 500 },
    (_, index) => `row ${String(index).padStart(3, "0")}.txt`,
  );
  const { folder } = await folderWithFiles(names);
  await page.goto(`/browse/${folder}`);
  await expect(entry(page, "row 000.txt")).toBeVisible();
  const scroller = page.locator('[data-slot="sidebar-inset"]');
  await scroller.evaluate((element) => element.scrollTo(0, 10_000));
  await expect(entry(page, "row 000.txt")).toHaveCount(0);
  // Start from the control just before the list, as someone tabbing through the page would.
  await page.getByRole("combobox", { name: "Sort files" }).focus();
  let reached = false;
  for (let press = 0; press < 6 && !reached; press++) {
    await page.keyboard.press("Tab");
    reached = await page.evaluate(
      () => document.activeElement?.closest("[data-entry-row]") !== null,
    );
  }
  expect(reached).toBe(true);
  // Focus lands on an entry already on screen, so the list does not jump back to the top.
  await expect(page.locator(":focus")).toBeInViewport();
});

test("entries of the previous folder take no actions while the next one loads", async ({
  page,
  isMobile,
}) => {
  const { folder, directory } = await folderWithFiles(["report.txt"]);
  await mkdir(path.join(directory, "next"));
  await page.goto(`/browse/${folder}`);
  const report = entry(page, "report.txt").filter({ visible: true });
  await report.click();
  const preview = page.getByRole("dialog", { name: "report.txt" });
  await expect(preview).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(preview).toBeHidden();
  // Select the file (with a modifier key on desktop), then open the subfolder, whose listing is
  // held back.
  if (!isMobile) {
    await report.click({ modifiers: ["ControlOrMeta"] });
    await expect(bar(page)).toBeVisible();
  }
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route(
    (url) =>
      url.pathname.includes("files.list") &&
      decodeURIComponent(url.search).includes(`${folder}/next`),
    async (route) => {
      await held;
      await route.continue();
    },
  );
  await entry(page, "next").filter({ visible: true }).click();
  await expect(page).toHaveURL(`/browse/${folder}/next`);
  // The selection belongs to the folder being left; nothing may act on it now.
  await expect(bar(page)).toBeHidden();
  await report.click({ timeout: 2_000 }).catch(() => undefined);
  await page.keyboard.press("Delete");
  await expect(preview).toBeHidden();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  release();
  await expect(
    page.getByRole("heading", { name: "This folder is empty" }),
  ).toBeVisible();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
});

test("files dropped outside an upload area never open in the tab, and leaving mid-upload asks first", async ({
  page,
}) => {
  const { folder } = await folderWithFiles(["kept.txt"]);
  await page.goto(`/browse/${folder}`);
  await expect(entry(page, "kept.txt").filter({ visible: true })).toBeVisible();
  // The browser opens a dropped file unless the page cancels dragover and drop. Synthetic
  // events never navigate, so check that the page cancels them everywhere.
  const cancelled = await page.evaluate(() =>
    ["header", "[data-slot=sidebar]", "body"].map((selector) => {
      const target = document.querySelector(selector) ?? document.body;
      const data = new DataTransfer();
      data.items.add(new File(["x"], "dropped.txt"));
      const over = new DragEvent("dragover", {
        bubbles: true,
        cancelable: true,
        dataTransfer: data,
      });
      const drop = new DragEvent("drop", {
        bubbles: true,
        cancelable: true,
        dataTransfer: data,
      });
      return !target.dispatchEvent(over) && !target.dispatchEvent(drop);
    }),
  );
  expect(cancelled).toEqual([true, true, true]);

  // An upload that is still sending.
  await page.route("**/api/upload**", () => {});
  await page
    .locator('input[type="file"]')
    .first()
    .setInputFiles({
      name: "slow.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("slow"),
    });
  await expect(page.getByText("Uploading 1 file")).toBeVisible();
  // Browsers ask only on pages the user has interacted with.
  await page.locator("header").click({ position: { x: 5, y: 5 } });
  const asked = page.waitForEvent("dialog");
  await page.close({ runBeforeUnload: true });
  const dialog = await asked;
  expect(dialog.type()).toBe("beforeunload");
  await dialog.accept();
});

test("starring a selection changes nothing when the starred items cannot be read", async ({
  page,
  isMobile,
  context,
}) => {
  test.skip(isMobile, "Selecting with modifier keys is a desktop interaction.");
  const { folder } = await folderWithFiles(["one.txt", "two.txt"]);
  await page.goto(`/browse/${folder}`);
  // The selection loads what is starred; that fails, so starring must not guess.
  await page.route(
    (url) => url.pathname.includes("catalog.bookmarks"),
    (route) => route.fulfill({ status: 503, body: "Unavailable" }),
  );
  await entry(page, "one.txt")
    .filter({ visible: true })
    .click({
      modifiers: ["ControlOrMeta"],
    });
  await entry(page, "two.txt")
    .filter({ visible: true })
    .click({
      modifiers: ["Shift"],
    });
  await expect(bar(page)).toContainText("2 selected");
  await bar(page).getByRole("button", { name: "Star", exact: true }).click();
  await expect(
    page
      .getByRole("region", { name: "Notifications" })
      .getByText("Nothing was starred or unstarred"),
  ).toBeVisible();
  const bookmarks = await (await client(context)).catalog.bookmarks.query();
  expect(
    bookmarks.filter(
      (bookmark) => bookmark.starred && bookmark.path.startsWith(`${folder}/`),
    ),
  ).toEqual([]);
});

test("error toasts are announced at once and stay until closed", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, "Selecting with modifier keys is a desktop interaction.");
  const { folder } = await folderWithFiles(["one.txt", "two.txt"]);
  await page.goto(`/browse/${folder}`);
  // The selection loads what is starred; that fails, so starring must not guess.
  await page.route(
    (url) => url.pathname.includes("catalog.bookmarks"),
    (route) => route.fulfill({ status: 503, body: "Unavailable" }),
  );
  await entry(page, "one.txt")
    .filter({ visible: true })
    .click({
      modifiers: ["ControlOrMeta"],
    });
  await entry(page, "two.txt")
    .filter({ visible: true })
    .click({
      modifiers: ["Shift"],
    });
  await bar(page).getByRole("button", { name: "Star", exact: true }).click();
  const message = "Nothing was starred or unstarred";
  await expect(
    page.getByRole("alert").filter({ hasText: message }),
  ).toBeAttached();
  const shown = page
    .getByRole("region", { name: "Notifications" })
    .getByText(message);
  await expect(shown).toBeVisible();
  // Success toasts time out after 4 seconds; errors are often the only list of what failed.
  await page.waitForTimeout(5_000);
  await expect(shown).toBeVisible();
  // Base UI keeps an urgent toast out of the accessibility tree until F6 focuses the
  // notifications, since the alert above already announced it; pointer users click it.
  await page.locator('[aria-label="Close toast"]').click();
  await expect(shown).toBeHidden();
});

test("the apply-to-all checkbox in the name clash dialog is named by its label and toggles from it", async ({
  page,
}) => {
  const { folder } = await folderWithFiles(["a.txt", "b.txt"]);
  await page.goto(`/browse/${folder}`);
  await expect(entry(page, "a.txt").filter({ visible: true })).toBeVisible();
  await whenCanCreate(page);
  await page
    .locator('input[type="file"]')
    .first()
    .setInputFiles([
      { name: "a.txt", mimeType: "text/plain", buffer: Buffer.from("new a") },
      { name: "b.txt", mimeType: "text/plain", buffer: Buffer.from("new b") },
    ]);
  const dialog = page.getByRole("dialog");
  const all = dialog.getByRole("checkbox", {
    name: "Apply to all 2 name clashes",
  });
  await expect(all).not.toBeChecked();
  await dialog.getByText("Apply to all 2 name clashes").click();
  await expect(all).toBeChecked();
  await dialog.getByText("Apply to all 2 name clashes").click();
  await expect(all).not.toBeChecked();
  await dialog.getByRole("button", { name: "Skip", exact: true }).click();
});

test("star controls say whether they add or remove stars, and do exactly that", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, "Selecting with modifier keys is a desktop interaction.");
  const { folder } = await folderWithFiles(["one.txt", "two.txt"]);
  await page.goto(`/browse/${folder}`);
  const menuItem = (name: string) =>
    page.getByRole("menuitem", { name, exact: true });
  const openMenu = async (name: string) => {
    await page
      .getByRole("button", { name: `Actions for ${name}`, exact: true })
      .click();
    await expect(page.getByRole("menu")).toBeVisible();
  };

  await openMenu("one.txt");
  await menuItem("Star").click();
  await expect(
    page.getByText("Added to Starred", { exact: true }),
  ).toBeVisible();
  await openMenu("one.txt");
  await expect(menuItem("Remove star")).toBeVisible();
  await expect(menuItem("Star")).toHaveCount(0);
  await page.keyboard.press("Escape");

  // One starred and one not: the selection stars both.
  await entry(page, "one.txt")
    .filter({ visible: true })
    .click({ modifiers: ["ControlOrMeta"] });
  await entry(page, "two.txt")
    .filter({ visible: true })
    .click({ modifiers: ["Shift"] });
  const star = bar(page).getByRole("button", { name: "Star", exact: true });
  await star.click();
  // Every selected item is now starred, so the same control removes their stars.
  const remove = bar(page).getByRole("button", {
    name: "Remove star",
    exact: true,
  });
  await expect(remove).toBeVisible();
  await remove.click();
  await expect(star).toBeVisible();
});

test("uploads to the drive root from the file picker, the folder picker and a drop", async ({
  page,
  context,
  isMobile,
}) => {
  const tag = randomUUID().slice(0, 8);
  const local = await mkdtemp(path.join(os.tmpdir(), "nimbus-root-upload-"));
  try {
    await mkdir(path.join(local, `root-folder-${tag}`));
    await writeFile(path.join(local, `root-folder-${tag}`, "inside.txt"), "In");
    await page.goto("/");
    const rpc = await client(context);
    const atRoot = async () =>
      FileListing.entries(await rpc.files.list.query({ path: "" })).map(
        (item) => item.name,
      );
    const choose = async (label: string, target: string) => {
      const chooser = page.waitForEvent("filechooser");
      await page
        .getByRole("button", {
          name: isMobile ? "New file or folder" : "New",
          exact: true,
        })
        .click();
      await page
        .getByRole(isMobile ? "button" : "menuitem", {
          name: label,
          exact: true,
        })
        .click();
      await (await chooser).setFiles(target);
    };

    await writeFile(path.join(local, `root-file-${tag}.txt`), "File");
    await choose("Upload file", path.join(local, `root-file-${tag}.txt`));
    await choose("Upload folder", path.join(local, `root-folder-${tag}`));
    // A drop on the folder's content delivers files through the same uploader.
    await page
      .getByRole("heading", { name: "Files", exact: true })
      .evaluate((heading, name) => {
        const data = new DataTransfer();
        data.items.add(new File(["Drop"], name, { type: "text/plain" }));
        for (const type of ["dragover", "drop"])
          heading.dispatchEvent(
            new DragEvent(type, {
              bubbles: true,
              cancelable: true,
              dataTransfer: data,
            }),
          );
      }, `root-drop-${tag}.txt`);

    await expect
      .poll(atRoot)
      .toEqual(
        expect.arrayContaining([
          `root-file-${tag}.txt`,
          `root-folder-${tag}`,
          `root-drop-${tag}.txt`,
        ]),
      );
    expect(
      FileListing.entries(
        await rpc.files.list.query({ path: `root-folder-${tag}` }),
      ).map((item) => item.name),
    ).toEqual(["inside.txt"]);
    await expect(page.getByText(/upload(s)? failed/)).toHaveCount(0);
  } finally {
    await rm(local, { recursive: true, force: true });
  }
});

test("a failed refresh keeps Starred's list and selection, and offers to try again", async ({
  page,
  context,
  isMobile,
}) => {
  test.skip(isMobile, "Selecting with modifier keys is a desktop interaction.");
  const { folder } = await folderWithFiles(["kept-a.txt", "kept-b.txt"]);
  const rpc = await client(context);
  for (const name of ["kept-a.txt", "kept-b.txt"])
    await rpc.catalog.bookmark.mutate({
      path: `${folder}/${name}`,
      starred: true,
    });
  await page.clock.install();
  await page.clock.resume();
  await page.goto("/starred");
  await expect(
    entry(page, "kept-a.txt").filter({ visible: true }),
  ).toBeVisible();
  await entry(page, "kept-b.txt")
    .filter({ visible: true })
    .click({ modifiers: ["ControlOrMeta"] });
  await expect(bar(page)).toContainText("1 selected");

  // Past the list's 30 seconds of freshness, the page refreshes it on returning to the tab,
  // which React Query hears as visibilitychange on window.
  let blocked = 0;
  const bookmarks = (url: URL) => url.pathname.includes("catalog.bookmarks");
  await page.route(bookmarks, (route) => {
    blocked += 1;
    return route.abort();
  });
  await page.clock.fastForward("00:45");
  await page.evaluate(() =>
    window.dispatchEvent(new Event("visibilitychange")),
  );
  await expect.poll(() => blocked).toBeGreaterThan(0);
  await expect(page.getByText("Could not refresh this list")).toBeVisible();
  await expect(
    entry(page, "kept-a.txt").filter({ visible: true }),
  ).toBeVisible();
  await expect(bar(page)).toContainText("1 selected");

  await page.unroute(bookmarks);
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.getByText("Could not refresh this list")).toBeHidden();
  await expect(bar(page)).toContainText("1 selected");
});
