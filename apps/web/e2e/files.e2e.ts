import { randomUUID } from "node:crypto";
import { expect } from "@playwright/test";
import { test } from "./helpers";
import {
  action,
  client,
  createFolder,
  downloadText,
  navigate,
  upload,
} from "./helpers";
import { FileListing } from "@nimbus/api/file-listing";

test("opens folders and downloads files with spaces in their names", async ({
  page,
  context,
  isMobile,
}) => {
  const folder = `Project documents ${randomUUID()}`;
  const nested = "Meeting notes 100% # café %20";
  const filename = "Weekly summary 100% # café %20.txt";
  const body = "File contents from a path with spaces.";
  const rpc = await client(context);
  await rpc.files.createFolder.mutate({ name: folder });
  await page.goto("/");
  await page.getByRole("link", { name: folder, exact: true }).click();
  await expect(page).toHaveURL(`/browse/${encodeURIComponent(folder)}`);
  await expect(
    page.getByRole("heading", { name: "This folder is empty" }),
  ).toBeVisible();
  await createFolder(page, nested, isMobile);
  await page.getByRole("link", { name: nested, exact: true }).click();
  await expect(page).toHaveURL(
    `/browse/${encodeURIComponent(folder)}/${encodeURIComponent(nested)}`,
  );
  await upload(page, filename, body);
  await page.reload();
  await page
    .locator(`[data-entry-name="${filename}"]`)
    .filter({ visible: true })
    .click();
  const preview = page.getByRole("dialog", { name: filename, exact: true });
  await expect(preview.locator("pre")).toHaveText(body);
  const downloadPromise = page.waitForEvent("download");
  await preview.getByRole("link", { name: "Download", exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe(filename);
  expect(await downloadText(download)).toBe(body);
  await preview.getByRole("button", { name: "Close", exact: true }).click();
  if (isMobile)
    await page
      .getByRole("button", { name: "Show folders in this path", exact: true })
      .click();
  await page
    .getByRole(isMobile ? "menuitem" : "link", { name: folder, exact: true })
    .click();
  await expect(page).toHaveURL(`/browse/${encodeURIComponent(folder)}`);
  await expect(
    page.getByRole("link", { name: nested, exact: true }),
  ).toBeVisible();
});

test("creates, uploads, previews, downloads, renames, moves and restores files", async ({
  page,
  context,
  isMobile,
}, testInfo) => {
  const folder = `documents-${randomUUID()}`;
  const filename = "meeting-notes.txt";
  const renamed = "renamed-notes.txt";
  const body = "Nimbus end-to-end file contents\nSecond line.";
  const rpc = await client(context);
  await page.goto("/");
  await createFolder(page, folder, isMobile);
  await page.getByRole("link", { name: folder, exact: true }).click();
  await expect(page).toHaveURL(`/browse/${folder}`);
  await expect(
    page.getByRole("heading", { name: "This folder is empty" }),
  ).toBeVisible();
  await upload(page, filename, body);
  await upload(page, "empty.txt", "");
  await page
    .locator('[data-entry-name="empty.txt"]')
    .filter({ visible: true })
    .click();
  const emptyPreview = page.getByRole("dialog", {
    name: "empty.txt",
    exact: true,
  });
  await expect(emptyPreview.locator("pre")).toHaveCount(1);
  await expect(emptyPreview.locator("pre")).toHaveText("");
  await emptyPreview
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await navigate(page, "Recent", isMobile);
  await expect(
    page.getByRole("heading", { name: "Recent", exact: true }),
  ).toBeVisible();
  await navigate(page, "My Drive", isMobile);
  await page.getByRole("link", { name: folder, exact: true }).click();
  await expect(page).toHaveURL(`/browse/${folder}`);
  await page
    .locator(`[data-entry-name="${filename}"]`)
    .filter({ visible: true })
    .click();
  const preview = page.getByRole("dialog", { name: filename, exact: true });
  await expect(preview.locator("pre")).toHaveText(body);
  const downloadPromise = page.waitForEvent("download");
  await preview.getByRole("link", { name: "Download", exact: true }).click();
  expect(await downloadText(await downloadPromise)).toBe(body);
  await page.screenshot({
    path: testInfo.outputPath("file-preview.png"),
    animations: "disabled",
  });
  await preview.getByRole("button", { name: "Close", exact: true }).click();
  await navigate(page, "Recent", isMobile);
  await expect(
    page
      .locator(`[data-entry-path="${folder}/${filename}"]`)
      .filter({ visible: true }),
  ).toBeVisible();
  await navigate(page, "My Drive", isMobile);
  await page.getByRole("link", { name: folder, exact: true }).click();
  await expect(page).toHaveURL(`/browse/${folder}`);
  await action(page, filename, "Rename", isMobile);
  const rename = page.getByRole("dialog", { name: "Rename", exact: true });
  await rename.getByRole("textbox").fill(renamed);
  await rename.getByRole("button", { name: "Rename", exact: true }).click();
  await expect(rename).toBeHidden();
  await expect(page.locator(`[data-entry-name="${filename}"]`)).toHaveCount(0);
  await expect(
    page.locator(`[data-entry-name="${renamed}"]`).filter({ visible: true }),
  ).toBeVisible();
  await action(page, renamed, "Star", isMobile);
  await expect(
    page.getByText("Added to Starred", { exact: true }),
  ).toBeVisible();
  await page.goto("/starred");
  await expect(
    page
      .locator(`[data-entry-path="${folder}/${renamed}"]`)
      .filter({ visible: true }),
  ).toBeVisible();
  await page.getByRole("combobox", { name: "Search files" }).fill(renamed);
  await page.getByRole("combobox", { name: "Search files" }).press("Enter");
  await expect(
    page.getByRole("heading", { name: `Search: ${renamed}` }),
  ).toBeVisible();
  await expect(
    page
      .locator(`[data-entry-path="${folder}/${renamed}"]`)
      .filter({ visible: true }),
  ).toBeVisible();
  await page.goto(`/browse/${folder}`);
  await createFolder(page, "archive", isMobile);
  await action(page, renamed, "Move to…", isMobile);
  const move = page.getByRole("dialog", { name: "Move", exact: true });
  await move.getByRole("button", { name: folder, exact: true }).click();
  await move.getByRole("button", { name: "archive", exact: true }).click();
  await move.getByRole("button", { name: "Move here" }).click();
  await expect(move).toBeHidden();
  await page.getByRole("link", { name: "archive", exact: true }).click();
  await expect(
    page.locator(`[data-entry-name="${renamed}"]`).filter({ visible: true }),
  ).toBeVisible();
  await action(page, renamed, "Move to trash", isMobile);
  const confirmation = page.getByRole("alertdialog", {
    name: "Move to trash?",
  });
  await confirmation.getByRole("button", { name: "Cancel" }).click();
  expect(
    FileListing.entries(
      await rpc.files.list.query({ path: `${folder}/archive` }),
    ).map((entry) => entry.name),
  ).toContain(renamed);
  await action(page, renamed, "Move to trash", isMobile);
  await confirmation
    .getByRole("button", { name: "Move to trash", exact: true })
    .click();
  await expect(confirmation).toBeHidden();
  await expect(page.locator(`[data-entry-name="${renamed}"]`)).toHaveCount(0);
  await page.goto("/trash");
  const trashed = page
    .getByRole("listitem")
    .filter({ hasText: `${folder}/archive/${renamed}` });
  await trashed.getByRole("button", { name: "Restore", exact: true }).click();
  await expect(trashed).toHaveCount(0);
  await page.goto(`/browse/${folder}/archive`);
  await expect(
    page.locator(`[data-entry-name="${renamed}"]`).filter({ visible: true }),
  ).toBeVisible();
  const restored = await context.request.get(
    `/api/files/download?path=${encodeURIComponent(`${folder}/archive/${renamed}`)}`,
  );
  expect(restored.status()).toBe(200);
  expect(await restored.text()).toBe(body);
  await page.evaluate(async () => {
    window.scrollTo(0, 0);
    document
      .querySelectorAll('[role="dialog"]')
      .forEach((dialog) => dialog.scrollTo(0, 0));
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
  });
  await page.screenshot({
    path: testInfo.outputPath("files.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Grid view", exact: true }).click();
  await expect
    .poll(async () => (await rpc.prefs.get.query()).view)
    .toBe("grid");
  const hydrated = page.waitForResponse((response) =>
    response.url().includes("access.capabilities"),
  );
  await page.reload();
  await hydrated;
  await expect(
    page.getByRole("button", { name: "Grid view", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "List view", exact: true }).click();
  await expect
    .poll(async () => (await rpc.prefs.get.query()).view)
    .toBe("list");
});
