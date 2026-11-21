import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, type Locator, type Page } from "@playwright/test";
import { z } from "zod";
import { action, client, test } from "./helpers";

/**
 * Every transfer the server may have carried out ends in a report the person can reach,
 * whatever the page was doing when its answer arrived, and never claims an outcome Nimbus
 * does not know.
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

/** A fresh folder below `under` (the drive root by default) holding `files`. */
async function tree(files: Record<string, string>, under = "") {
  const top = path.posix.join(under, `reports-${randomUUID()}`);
  const root = path.join(await dataRoot(), top);
  await mkdir(root, { recursive: true });
  for (const [file, body] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), body);
  }
  return {
    top,
    names: async (relative = "") =>
      (await readdir(path.join(root, relative))).sort(),
    write: (relative: string, body: string) =>
      writeFile(path.join(root, relative), body),
  };
}

const href = (folder: string) =>
  `/browse/${folder.split("/").map(encodeURIComponent).join("/")}`;
const picker = (page: Page) => page.locator("[data-picker]");
const toasts = (page: Page) => page.locator('[data-slot="toast"]');
/** A toast's button. An error toast stays out of the accessibility tree until focused. */
const button = (toast: Locator, label: string) =>
  toast.locator("button", { hasText: label });
const mod = process.platform === "darwin" ? "Meta" : "Control";

async function select(page: Page, names: readonly string[]) {
  for (const name of names)
    await page
      .getByRole("button", { name, exact: true })
      .click({ modifiers: [mod] });
}

async function moveUp(page: Page, names: readonly string[]) {
  await select(page, names);
  await page
    .getByRole("toolbar", { name: "Selected items" })
    .getByRole("button", { name: "Move up one level" })
    .click();
}

async function moveToSibling(dialog: Locator, top: string, folder: string) {
  await dialog.getByRole("button", { name: "Up one folder" }).click();
  await dialog.locator(`[data-folder-path="${top}/${folder}"]`).click();
  await dialog.getByRole("button", { name: `Move to “${folder}”` }).click();
}

/**
 * Lets the first `count` requests matching `pattern` (the client sends requests made together
 * as one) reach the server, which carries them
 * out, and holds their answers until `release`.
 */
async function holdAnswers(page: Page, pattern: string, count = 1) {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let arrived = 0;
  let seen = () => {};
  const requested = new Promise<void>((resolve) => {
    seen = resolve;
  });
  await page.route(pattern, async (route) => {
    if (arrived >= count) return route.fallback();
    arrived++;
    const response = await route.fetch();
    if (arrived === count) seen();
    await held;
    await route.fulfill({ response });
  });
  return { requested, release };
}

/** Lets matching requests reach the server, which carries them out, and loses each answer. */
async function loseAnswers(page: Page, pattern: string) {
  await page.route(pattern, async (route) => {
    await route.fetch();
    await route.abort("connectionreset");
  });
}

test.describe("moves whose answers arrive late", () => {
  test.skip(
    ({ isMobile }) => isMobile,
    "The selection bar's Move up needs a mouse and a wide window.",
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

  test("reports a late Move up whose name clashed while a picker is open, with Undo for what moved", async ({
    page,
  }) => {
    const drive = await tree({
      "docs/a.txt": "mine",
      "docs/b.txt": "b",
      "docs/c.txt": "c",
      "a.txt": "theirs",
    });
    await page.goto(href(`${drive.top}/docs`));
    const late = await holdAnswers(page, "**/api/trpc/files.move*");
    await moveUp(page, ["a.txt", "b.txt"]);
    await late.requested;
    await action(page, "c.txt", "Move to…", false);
    const dialog = picker(page);
    await expect(
      dialog.getByRole("heading", { name: "Move “c.txt”" }),
    ).toBeVisible();
    late.release();
    await expect.poll(() => drive.names()).toContain("b.txt");
    await page.waitForTimeout(400);
    // The open picker is not handed a move it did not start.
    await expect(
      dialog.getByRole("heading", { name: "Move “c.txt”" }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    const report = toasts(page).filter({
      hasText: "Moved 1 of 2 items to",
    });
    await expect(report).toContainText("“a.txt” is already there.");
    await expect(button(report, "Keep both")).toBeVisible();
    await expect(button(report, "Rename…")).toBeVisible();
    await button(report, "Undo").click();
    await expect.poll(() => drive.names("docs")).toContain("b.txt");
  });

  test("reports a late Move up whose name clashed while the picker asks about its own clash", async ({
    page,
  }) => {
    const drive = await tree({
      "docs/a.txt": "mine",
      "docs/b.txt": "b",
      "docs/c.txt": "mine",
      "a.txt": "theirs",
      "c.txt": "theirs",
    });
    await page.goto(href(`${drive.top}/docs`));
    const late = await holdAnswers(page, "**/api/trpc/files.move*");
    await moveUp(page, ["a.txt", "b.txt"]);
    await late.requested;
    await action(page, "c.txt", "Move to…", false);
    const dialog = picker(page);
    await dialog.getByRole("button", { name: "Up one folder" }).click();
    await dialog
      .getByRole("button", { name: `Move to “${drive.top}”` })
      .click();
    await expect(
      dialog.getByText(`“c.txt” is already in ${drive.top}`),
    ).toBeVisible();
    late.release();
    await expect.poll(() => drive.names()).toContain("b.txt");
    await page.waitForTimeout(400);
    await expect(
      dialog.getByText(`“c.txt” is already in ${drive.top}`),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(
      toasts(page).filter({ hasText: "“c.txt” is already there." }),
    ).toBeVisible();
    const report = toasts(page).filter({
      hasText: "“a.txt” is already there.",
    });
    // Reports stack, the newest in front: hovering them spreads them out.
    await toasts(page).first().hover();
    await button(report, "Undo").click();
    await expect.poll(() => drive.names("docs")).toContain("b.txt");
  });

  test("reports both of two late moves that arrive together, each name clash with its choices", async ({
    page,
  }) => {
    const drive = await tree({
      "docs/a.txt": "mine",
      "docs/b.txt": "b",
      "docs/c.txt": "mine",
      "docs/e.txt": "e",
      "a.txt": "theirs",
      "c.txt": "theirs",
    });
    await page.goto(href(`${drive.top}/docs`));
    const late = await holdAnswers(page, "**/api/trpc/files.move*", 2);
    await moveUp(page, ["a.txt", "b.txt"]);
    await page.keyboard.press("Escape");
    await moveUp(page, ["c.txt", "e.txt"]);
    await late.requested;
    late.release();
    await expect
      .poll(() => drive.names())
      .toEqual(expect.arrayContaining(["b.txt", "e.txt"]));
    // One of them opens the picker at its clash; the other is reported on its own.
    const dialog = picker(page);
    await expect(dialog.getByRole("alertdialog")).toBeVisible();
    await page.waitForTimeout(400);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    for (const clash of ["a.txt", "c.txt"])
      await expect(
        toasts(page).filter({ hasText: `“${clash}” is already there.` }),
      ).toBeVisible();
    for (const clash of ["a.txt", "c.txt"]) {
      await toasts(page).first().hover();
      await button(
        toasts(page).filter({ hasText: `“${clash}” is already there.` }),
        "Undo",
      ).click();
    }
    await expect
      .poll(() => drive.names("docs"))
      .toEqual(["a.txt", "b.txt", "c.txt", "e.txt"]);
  });
});

test("says it could not confirm a move whose answer was lost, and never claims it moved or not", async ({
  page,
  isMobile,
}) => {
  const drive = await tree({ "docs/a.txt": "a", "archive/.keep": "" });
  await page.goto(href(`${drive.top}/docs`));
  await action(page, "a.txt", "Move to…", isMobile);
  await loseAnswers(page, "**/api/trpc/files.move*");
  await moveToSibling(picker(page), drive.top, "archive");
  await expect(picker(page)).toBeHidden();
  // The server did move it; Nimbus cannot know that, and says so.
  expect(await drive.names("archive")).toEqual([".keep", "a.txt"]);
  const report = toasts(page).filter({
    hasText: "Nimbus could not confirm whether “a.txt” moved. Check archive.",
  });
  await expect(report).toBeVisible();
  await expect(report).not.toContainText("Nothing was moved");
  await button(report, "Open folder").click();
  await expect(page).toHaveURL(new RegExp(`${href(`${drive.top}/archive`)}$`));
});

test("says it could not confirm an Undo whose answer was lost", async ({
  page,
  isMobile,
}) => {
  const drive = await tree({ "docs/a.txt": "a", "archive/.keep": "" });
  await page.goto(href(`${drive.top}/docs`));
  await action(page, "a.txt", "Move to…", isMobile);
  await moveToSibling(picker(page), drive.top, "archive");
  await expect(picker(page)).toBeHidden();
  await loseAnswers(page, "**/api/trpc/files.undo*");
  await toasts(page)
    .filter({ hasText: "Moved “a.txt” to archive." })
    .getByRole("button", { name: "Undo" })
    .click();
  // The toast itself: Base UI also announces an error in an alert region of its own.
  await expect(
    toasts(page).filter({
      hasText:
        "Nimbus could not confirm whether “a.txt” was put back. Check docs and archive.",
    }),
  ).toBeVisible();
  await expect(page.getByText("Nothing was undone")).toHaveCount(0);
});

test("keeps a multi-destination report while Details is open, then lets it go", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, "Touch multi-selection is covered elsewhere.");
  const drive = await tree({
    "docs/a.txt": "a",
    "docs/b.txt": "b",
    "one/b.txt": "taken",
    "two/.keep": "",
  });
  await (
    await client(page.context())
  ).prefs.set.mutate({
    view: "list",
    sortField: "name",
    sortDirection: "asc",
    groupByType: true,
  });
  await page.goto(href(`${drive.top}/docs`));
  await select(page, ["a.txt", "b.txt"]);
  await page
    .getByRole("toolbar", { name: "Selected items" })
    .getByRole("button", { name: "Move", exact: true })
    .click();
  const dialog = picker(page);
  await moveToSibling(dialog, drive.top, "one");
  await expect(dialog.getByRole("alertdialog")).toBeVisible();
  await moveToSibling(dialog, drive.top, "two");
  await expect(dialog).toBeHidden();
  const report = toasts(page).filter({
    hasText: "Moved 2 items to 2 folders.",
  });
  await report.getByRole("button", { name: "Details" }).click();
  const details = page.getByRole("dialog", { name: "What was moved" });
  await expect(details).toBeVisible();
  // Longer than the report's own lifetime.
  await page.waitForTimeout(11_000);
  await expect(report).toHaveCount(1);
  await details.getByRole("button", { name: "Close" }).first().click();
  await expect(details).toBeHidden();
  await page.mouse.move(5, 5);
  await expect(report).toHaveCount(0, { timeout: 14_000 });
});
