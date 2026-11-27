import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, type Page } from "@playwright/test";
import { z } from "zod";
import { action, client, test } from "./helpers";

/**
 * An accidental drag or move can always be taken back: a drag cancels with Esc or by dropping
 * where nothing happens, a running move stops from its progress, and what moved has Undo.
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

/** A fresh top folder holding `files` (path to contents). */
async function tree(files: Record<string, string>) {
  const top = `cancel-${randomUUID()}`;
  const root = path.join(await dataRoot(), top);
  for (const [file, body] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), body);
  }
  return {
    top,
    names: async (relative = "") =>
      (await readdir(path.join(root, relative))).sort(),
  };
}

const href = (folder: string) =>
  `/browse/${folder.split("/").map(encodeURIComponent).join("/")}`;
const toasts = (page: Page) => page.locator('[data-slot="toast"]');
const hint = (page: Page, text: string) =>
  page.getByRole("status").filter({ hasText: text });

/**
 * Holds every request matching `pattern` after the first `pass`, before it reaches the server,
 * until the page asks the server to cancel a transfer: the server then learns of the cancel
 * before the held items.
 */
async function holdUntilCancelled(page: Page, pattern: string, pass: number) {
  let cancelled = () => {};
  const asked = new Promise<void>((resolve) => {
    cancelled = resolve;
  });
  await page.route("**/api/trpc/files.cancelTransfer*", async (route) => {
    const response = await route.fetch();
    cancelled();
    await route.fulfill({ response });
  });
  let seen = 0;
  let held = () => {};
  const holding = new Promise<void>((resolve) => {
    held = resolve;
  });
  await page.route(pattern, async (route) => {
    if (seen++ < pass) return route.continue();
    held();
    await asked;
    await route.continue();
  });
  return { holding };
}

test.describe("dragging", () => {
  test.skip(
    ({ isMobile }) => isMobile,
    "Touch screens never drag items; they move them from the item's actions.",
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

  test("says how to cancel, and changes nothing on Esc or a drop where nothing would happen", async ({
    page,
  }) => {
    const drive = await tree({ "Into/kept.txt": "k", "Photos/a.txt": "a" });
    await page.goto(href(drive.top));
    const photos = page.getByRole("link", { name: "Photos", exact: true });
    const into = page.getByRole("link", { name: "Into", exact: true });

    // Esc mid-drag: the drop that follows over a folder does nothing.
    await photos.hover();
    await page.mouse.down();
    await page.mouse.move(700, 600, { steps: 4 });
    await expect(
      hint(page, "Drop on a folder to move “Photos” · Esc to cancel"),
    ).toBeVisible();
    await into.hover();
    await into.hover();
    await expect(
      hint(page, "Move “Photos” to “Into” · Esc to cancel"),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(into).not.toHaveAttribute("data-drop-target");
    await page.mouse.up();
    await expect(hint(page, "Esc to cancel")).toHaveCount(0);

    // Onto itself, and onto empty space: refused or ignored.
    await photos.hover();
    await page.mouse.down();
    await page.mouse.move(700, 600, { steps: 4 });
    await photos.hover();
    await photos.hover();
    await expect(
      hint(page, "“Photos” cannot go into itself · Esc to cancel"),
    ).toBeVisible();
    await page.mouse.up();
    await photos.hover();
    await page.mouse.down();
    await page.mouse.move(700, 800, { steps: 4 });
    await page.mouse.move(720, 810, { steps: 2 });
    await page.mouse.up();

    await expect(toasts(page)).toHaveCount(0);
    expect(await drive.names()).toEqual(["Into", "Photos"]);
    expect(await drive.names("Into")).toEqual(["kept.txt"]);
    expect(await drive.names("Photos")).toEqual(["a.txt"]);
  });

  test("cancels a slow move from its progress: what moved stays with Undo, the rest is untouched", async ({
    page,
  }) => {
    const files: Record<string, string> = { "Into/kept.txt": "k" };
    const all = Array.from(
      { length: 40 },
      (_, index) => `f${String(index).padStart(2, "0")}.txt`,
    );
    for (const name of all) files[name] = name;
    const drive = await tree(files);
    await page.goto(href(drive.top));
    // The first items go through; the next wait until the cancel has reached the server.
    const slow = await holdUntilCancelled(page, "**/api/trpc/files.move*", 1);
    await page
      .getByRole("button", { name: "f00.txt", exact: true })
      .click({ modifiers: ["Control"] });
    await page
      .getByRole("button", { name: "f39.txt", exact: true })
      .click({ modifiers: ["Shift"] });
    const into = page.getByRole("link", { name: "Into", exact: true });
    await page.getByRole("button", { name: "f05.txt", exact: true }).hover();
    await page.mouse.down();
    await into.hover();
    await into.hover();
    await expect(
      hint(page, "Move 40 items to “Into” · Esc to cancel"),
    ).toBeVisible();
    await page.mouse.up();
    await slow.holding;

    const running = toasts(page).filter({
      hasText: "Moving 40 items to Into…",
    });
    await running.getByRole("button", { name: "Cancel", exact: true }).click();
    const report = toasts(page).filter({ hasText: "Cancelled:" });
    await expect(report).toBeVisible();
    const moved = (await drive.names("Into")).filter(
      (name) => name !== "kept.txt",
    );
    expect(moved.length).toBeGreaterThan(0);
    expect(moved.length).toBeLessThan(all.length);
    await expect(report).toHaveText(
      new RegExp(
        `Moved ${moved.length} of 40 items to Into\\. Cancelled: ${all.length - moved.length} items were not moved\\.`,
      ),
    );
    const stayed = (await drive.names()).filter((name) => name !== "Into");
    expect([...moved, ...stayed].sort()).toEqual(all);

    // Undo puts back exactly what moved.
    await report.getByRole("button", { name: "Undo", exact: true }).click();
    await expect(
      toasts(page).filter({ hasText: `Moved ${moved.length} items back` }),
    ).toBeVisible();
    expect(await drive.names("Into")).toEqual(["kept.txt"]);
    expect(await drive.names()).toEqual(["Into", ...all]);
  });

  test("offers Undo after a drag, by keyboard as well", async ({ page }) => {
    const drive = await tree({ "Into/kept.txt": "k", "notes.txt": "n" });
    await page.goto(href(drive.top));
    await page
      .getByRole("button", { name: "notes.txt", exact: true })
      .dragTo(page.getByRole("link", { name: "Into", exact: true }));
    const report = toasts(page).filter({
      hasText: "Moved “notes.txt” to Into.",
    });
    await expect(report).toBeVisible();
    // F6 reaches the toasts, which stay while focused.
    await page.keyboard.press("F6");
    const undo = report.getByRole("button", { name: "Undo", exact: true });
    for (let tab = 0; tab < 3; tab++) {
      if (await undo.evaluate((button) => button === document.activeElement))
        break;
      await page.keyboard.press("Tab");
    }
    await expect(undo).toBeFocused();
    await page.keyboard.press("Enter");
    await expect.poll(() => drive.names()).toEqual(["Into", "notes.txt"]);
    expect(await drive.names("Into")).toEqual(["kept.txt"]);
  });
});

test("cancels a move from the picker while it runs, by touch as well", async ({
  page,
  isMobile,
}) => {
  const drive = await tree({ "docs/a.txt": "a", "archive/kept.txt": "k" });
  await page.goto(href(`${drive.top}/docs`));
  const slow = await holdUntilCancelled(page, "**/api/trpc/files.move*", 0);
  await action(page, "a.txt", "Move to…", isMobile);
  const dialog = page.locator("[data-picker]");
  await dialog.getByRole("button", { name: "Up one folder" }).click();
  await dialog.locator(`[data-folder-path="${drive.top}/archive"]`).click();
  await dialog.getByRole("button", { name: "Move to “archive”" }).click();
  await slow.holding;
  await expect(
    dialog.getByText("Cancel stops the move; what is done stays, with Undo."),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(
    toasts(page).filter({
      hasText: "Cancelled. Nothing was moved to archive.",
    }),
  ).toBeVisible();
  expect(await drive.names("docs")).toEqual(["a.txt"]);
  expect(await drive.names("archive")).toEqual(["kept.txt"]);
});
