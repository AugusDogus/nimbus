import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect } from "@playwright/test";
import { z } from "zod";
import { client, port, test } from "./helpers";

async function dataRoot() {
  const manifest: unknown = JSON.parse(
    await readFile(path.join(os.tmpdir(), `nimbus-e2e-${port}.json`), "utf8"),
  );
  return z
    .object({ dataRoot: z.string().startsWith(os.tmpdir()) })
    .parse(manifest).dataRoot;
}

test("suggests matches while typing and keeps the index current", async ({
  page,
  context,
}) => {
  const token = randomUUID().slice(0, 8);
  const folder = `search-${token}`;
  await (await client(context)).files.createFolder.mutate({ name: folder });
  const directory = path.join(await dataRoot(), folder, "nested");
  await mkdir(directory);
  await writeFile(
    path.join(directory, `quarterly-${token}.txt`),
    "Quarterly numbers",
  );
  await page.goto("/");
  const box = page.getByRole("combobox", { name: "Search files" });
  await box.fill(`quarterly-${token}`);
  const suggestions = page.getByRole("listbox", { name: "Search suggestions" });
  const option = suggestions.getByRole("option", {
    name: new RegExp(`quarterly-${token}\\.txt`),
  });
  // Watcher events reach the index asynchronously.
  await expect(async () => {
    await box.fill("");
    await box.fill(`quarterly-${token}`);
    await expect(option).toBeVisible({ timeout: 2_000 });
  }).toPass();
  await expect(option).toContainText(`${folder}/nested`);
  await box.press("ArrowDown");
  await expect(option).toHaveAttribute("aria-selected", "true");
  await box.press("Enter");
  const preview = page.getByRole("dialog", {
    name: `quarterly-${token}.txt`,
    exact: true,
  });
  await expect(preview.locator("pre")).toHaveText("Quarterly numbers");
  await preview.getByRole("button", { name: "Close", exact: true }).click();

  await box.fill(token);
  await box.press("Enter");
  await expect(page).toHaveURL(`/search?q=${token}`);
  const row = page
    .locator(`[data-entry-path="${folder}/nested/quarterly-${token}.txt"]`)
    .filter({ visible: true });
  await expect(row).toContainText(`${folder}/nested`);
  await expect(
    page.locator(`[data-entry-path="${folder}"]`).filter({ visible: true }),
  ).toBeVisible();
});

test("finds words across folders and loads every match", async ({
  page,
  context,
}) => {
  const token = randomUUID().slice(0, 8);
  const folder = `layers-${token}`;
  await (await client(context)).files.createFolder.mutate({ name: folder });
  const year = path.join(await dataRoot(), folder, "2024");
  await mkdir(year);
  for (let i = 0; i < 205; i++)
    await writeFile(path.join(year, `invoice-${token}-${i}.txt`), "x");

  await page.goto("/");
  const box = page.getByRole("combobox", { name: "Search files" });
  const suggestions = page.getByRole("listbox", { name: "Search suggestions" });
  // The year is only in the folder; the token only in the names.
  const first = suggestions.getByRole("option", {
    name: new RegExp(`invoice-${token}-\\d+\\.txt`),
  });
  await expect(async () => {
    await box.fill("");
    await box.fill(`2024 ${token}`);
    await expect(first.first()).toBeVisible({ timeout: 2_000 });
  }).toPass();
  await expect(first.first().locator("mark").first()).toHaveText(token);
  await expect(first.first().locator("mark").last()).toHaveText("2024");
  // The files, and the 2024 folder itself: its name holds the year, its parent the token.
  await expect(
    suggestions.getByRole("option", { name: /Show all 206 results/ }),
  ).toBeVisible();

  await box.press("Enter");
  const status = page.getByRole("status").filter({ hasText: "matches" });
  await expect(status).toHaveText("Showing 200 of 206 matches.");
  await page.getByRole("button", { name: "Show 6 more", exact: true }).click();
  await expect(status).toHaveText("206 matches.");
});
