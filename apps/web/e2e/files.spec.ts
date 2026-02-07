import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { expect, test } from "@playwright/test";
import { createTRPCClient, httpBatchLink } from "@trpc/client";

import { statPath } from "@nimbus/api/fs-utils";
import type { AppRouter } from "@nimbus/api/routers";

const dataRoot = path.resolve(__dirname, "fixtures", "data-root");

const ensureFixtures = async () => {
  await mkdir(path.join(dataRoot, "docs"), { recursive: true });
  await writeFile(path.join(dataRoot, "docs", "readme.md"), "docs");
};

const cleanupTestFiles = async () => {
  const entries = await readdir(dataRoot);
  const targets = entries.filter(
    (entry) =>
      entry.startsWith("delete-") ||
      entry.startsWith("rename-") ||
      entry.startsWith("renamed-"),
  );
  await Promise.all(
    targets.map((entry) => rm(path.join(dataRoot, entry), { force: true })),
  );
};

const removeIfExists = async (filename: string) => {
  await rm(path.join(dataRoot, filename), { force: true });
};

const fileExists = async (filename: string) => {
  try {
    await statPath(path.join(dataRoot, filename));
    return true;
  } catch {
    return false;
  }
};

test("renames a file", async ({ page }) => {
  await ensureFixtures();
  await cleanupTestFiles();
  const source = `rename-${Date.now()}.txt`;
  const target = `renamed-${Date.now()}.txt`;
  await writeFile(path.join(dataRoot, source), "hello");

  await page.goto("/files");
  const sourceEntry = page.locator(`[data-entry-name="${source}"]`).first();
  await expect(sourceEntry).toBeVisible();

  await sourceEntry.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Rename" }).click();
  const renameDialog = page.getByRole("dialog", { name: "Rename" });
  await renameDialog.getByRole("textbox").fill(target);
  await renameDialog.getByRole("button", { name: "Rename" }).click();
  await expect(renameDialog).toBeHidden();
  const targetEntry = page.locator(`[data-entry-name="${target}"]`).first();
  await expect(targetEntry).toBeVisible();

  await expect
    .poll(() => fileExists(target), { timeout: 10_000 })
    .toBe(true);
  await expect
    .poll(() => fileExists(source), { timeout: 10_000 })
    .toBe(false);

  await removeIfExists(target);
});

test("deletes a file", async ({ page }) => {
  await ensureFixtures();
  await cleanupTestFiles();
  const filename = `delete-${Date.now()}.txt`;
  await writeFile(path.join(dataRoot, filename), "hello");
  const trpcClient = createTRPCClient<AppRouter>({
    links: [
      httpBatchLink({
        url: "http://localhost:3000/api/trpc",
      }),
    ],
  });

  await page.goto("/files");
  const entry = page.locator(`[data-entry-name="${filename}"]`).first();
  await expect(entry).toBeVisible();

  await entry.click({ button: "right" });
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitem", { name: "Delete", exact: true }).click();
  const deleteDialog = page.getByRole("alertdialog", { name: /Delete/ });
  await expect(deleteDialog).toBeVisible();
  await deleteDialog.getByRole("button", { name: "Cancel" }).click();
  await expect(deleteDialog).toBeHidden();

  const serverList = await trpcClient.files.list.query({});
  expect(serverList.some((item) => item.name === filename)).toBe(true);

  await trpcClient.files.delete.mutate({ path: filename });

  await expect
    .poll(() => fileExists(filename), { timeout: 10_000 })
    .toBe(false);
  await page.reload();
  await expect(page.locator(`[data-entry-name="${filename}"]`)).toHaveCount(0);
});

test("navigates into a folder", async ({ page }) => {
  await ensureFixtures();
  await cleanupTestFiles();
  await page.goto("/files");
  await page.getByRole("link", { name: "docs" }).click();
  await expect(page.getByText("readme.md")).toBeVisible();
});
