import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, type Page } from "@playwright/test";
import { action, client, port, test } from "./helpers";

// A dialog with nothing to lose closes on a press outside it. One whose form differs from how it
// opened ignores that press, so a stray tap does not throw typing away; Escape, Cancel and the
// close button still close it.

/** A press on the page outside the dialog: a click, or a tap on touch screens. */
async function pressOutside(page: Page, hasTouch: boolean) {
  if (hasTouch) await page.touchscreen.tap(6, 6);
  else await page.mouse.click(6, 6);
}

test("Rename closes on a press outside until a name is typed, then only by Escape or Cancel", async ({
  page,
  isMobile,
  hasTouch,
}) => {
  const rpc = await client(page.context());
  const folder = `dismiss-${randomUUID()}`;
  await rpc.files.createFolder.mutate({ name: folder });
  await rpc.files.createFolder.mutate({ path: folder, name: "draft" });
  await page.goto(`/browse/${folder}`);
  const rename = page.getByRole("dialog", { name: /^Rename/ });

  await action(page, "draft", "Rename", isMobile);
  await expect(rename).toBeVisible();
  await pressOutside(page, hasTouch);
  await expect(rename).toBeHidden();

  await action(page, "draft", "Rename", isMobile);
  const field = rename.getByRole("textbox");
  await field.fill("final");
  await pressOutside(page, hasTouch);
  await expect(rename).toBeVisible();
  await expect(field).toHaveValue("final");
  // Put back as it was, there is nothing to lose again.
  await field.fill("draft");
  await pressOutside(page, hasTouch);
  await expect(rename).toBeHidden();

  await action(page, "draft", "Rename", isMobile);
  await field.fill("final");
  await page.keyboard.press("Escape");
  await expect(rename).toBeHidden();
  await expect(
    page.locator('[data-entry-name="draft"]').filter({ visible: true }),
  ).toBeVisible();
});

test("a form of several fields keeps what was typed against a press outside, and Cancel still closes it", async ({
  page,
  hasTouch,
}) => {
  await page.goto("/admin");
  const open = () =>
    page.getByRole("button", { name: "Create account", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "Create account",
    exact: true,
  });

  await open();
  await expect(dialog).toBeVisible();
  await pressOutside(page, hasTouch);
  await expect(dialog).toBeHidden();

  await open();
  await dialog.getByLabel("Name", { exact: true }).fill("Robin Example");
  await dialog.getByLabel("Email", { exact: true }).fill("robin@example.test");
  await pressOutside(page, hasTouch);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("Email", { exact: true })).toHaveValue(
    "robin@example.test",
  );
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toBeHidden();
});

async function dataRoot() {
  const manifest: unknown = JSON.parse(
    await readFile(path.join(os.tmpdir(), `nimbus-e2e-${port}.json`), "utf8"),
  );
  if (
    typeof manifest !== "object" ||
    manifest === null ||
    !("dataRoot" in manifest) ||
    typeof manifest.dataRoot !== "string"
  )
    throw new Error("The e2e server wrote no data root.");
  return manifest.dataRoot;
}

test("the text editor asks before discarding edits, and ignores a press outside", async ({
  page,
  context,
  hasTouch,
}) => {
  const folder = `discard-${randomUUID()}`;
  await (await client(context)).files.createFolder.mutate({ name: folder });
  await writeFile(path.join(await dataRoot(), folder, "plan.txt"), "first");
  await page.goto(`/browse/${folder}`);
  await page
    .locator('[data-entry-name="plan.txt"]')
    .filter({ visible: true })
    .click();
  const preview = page.getByRole("dialog", { name: "plan.txt", exact: true });
  await preview.getByRole("button", { name: "Edit", exact: true }).click();
  const text = preview.getByRole("textbox", { name: "File contents" });
  await text.fill("first, then more");

  await pressOutside(page, hasTouch);
  await expect(preview).toBeVisible();
  await expect(text).toHaveValue("first, then more");

  const confirm = page.getByRole("alertdialog", {
    name: "Discard your edits?",
  });
  await page.keyboard.press("Escape");
  await expect(confirm).toBeVisible();
  await confirm
    .getByRole("button", { name: "Keep editing", exact: true })
    .click();
  await expect(confirm).toBeHidden();
  await expect(text).toHaveValue("first, then more");

  await page.keyboard.press("Escape");
  await confirm
    .getByRole("button", { name: "Discard edits", exact: true })
    .click();
  await expect(preview).toBeHidden();
  expect(
    await readFile(path.join(await dataRoot(), folder, "plan.txt"), "utf8"),
  ).toBe("first");
});
