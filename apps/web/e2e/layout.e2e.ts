import { randomUUID } from "node:crypto";
import { expect, type Page } from "@playwright/test";
import { client, test } from "./helpers";
import { Device } from "../lib/device";

/** The page, and every open dialog, fit the screen's width: nothing scrolls sideways. */
async function fitsWidth(page: Page) {
  return page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    const wide: string[] = [];
    if (document.documentElement.scrollWidth > width) wide.push("page");
    for (const dialog of document.querySelectorAll(
      "[role=dialog], [role=alertdialog]",
    )) {
      const box = dialog.getBoundingClientRect();
      if (box.left < -1 || box.right > width + 1)
        wide.push(dialog.getAttribute("aria-label") ?? "dialog");
    }
    return wide;
  });
}

// 320 CSS pixels is the narrowest phone; 640 by 400 is a 1280 by 800 screen at 200% zoom.
for (const size of [
  { width: 320, height: 640 },
  { width: 640, height: 400 },
])
  test(`pages and dialogs fit ${size.width}x${size.height} without sideways scrolling`, async ({
    page,
    context,
    isMobile,
  }, testInfo) => {
    test.skip(isMobile, "The sizes are set explicitly; one project is enough.");
    const folder = `layout-${randomUUID()}`;
    const rpc = await client(context);
    await rpc.files.createFolder.mutate({ name: folder });
    await rpc.files.createFolder.mutate({
      path: folder,
      name: "a folder with a rather long name that has to wrap somewhere",
    });
    await page.setViewportSize(size);
    for (const path of [
      "/",
      `/browse/${folder}`,
      `/search?q=${folder}`,
      "/trash",
      "/shared",
      "/recent",
      "/settings/account",
      "/settings/appearance",
      "/settings/webdav",
      "/settings/mcp",
    ]) {
      await page.goto(path, { waitUntil: "load" });
      await page.waitForFunction(() => document.readyState === "complete");
      await page.waitForTimeout(300);
      await page.screenshot({
        path: testInfo.outputPath(
          `${size.width}${path.replaceAll(/[/?=]/g, "_")}.png`,
        ),
      });
      expect(await fitsWidth(page), path).toEqual([]);
    }
    // Dialogs: rename and sharing, opened from the entry's menu.
    await page.goto(`/browse/${folder}`);
    const name = "a folder with a rather long name that has to wrap somewhere";
    for (const label of ["Rename", "Share"]) {
      await page
        .getByRole("button", { name: `Actions for ${name}`, exact: true })
        .click();
      await page
        .getByRole(size.width < Device.narrowBelow ? "button" : "menuitem", {
          name: label,
          exact: true,
        })
        .click();
      const dialog = page.getByRole("dialog", { name: new RegExp(label) });
      await expect(dialog).toBeVisible();
      await page.screenshot({
        path: testInfo.outputPath(`${size.width}-dialog-${label}.png`),
      });
      expect(await fitsWidth(page), label).toEqual([]);
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
    }
  });
