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

test("finds names with a typo under a separate heading", async ({
  page,
  context,
}) => {
  const token = randomUUID().slice(0, 8);
  const folder = `typo-${token}`;
  await (await client(context)).files.createFolder.mutate({ name: folder });
  const word = `zephyrine${token.replace(/\d/g, "")}`;
  await writeFile(path.join(await dataRoot(), folder, `${word}.txt`), "x");
  // Two neighbouring letters swapped.
  const typo = `${word.slice(0, 2)}${word[3]}${word[2]}${word.slice(4)}`;
  await expect(async () => {
    await page.goto(`/search?q=${encodeURIComponent(typo)}`);
    await expect(page.getByText("Similar names", { exact: true })).toBeVisible({
      timeout: 2_000,
    });
  }).toPass();
  const row = page
    .locator(`[data-entry-path="${folder}/${word}.txt"]`)
    .filter({ visible: true });
  await expect(row.locator("mark").first()).toHaveText(word);
});

test("drops a trashed result loaded by Show more and updates the count", async ({
  page,
  context,
}) => {
  const token = randomUUID().slice(0, 8);
  const folder = `paged-${token}`;
  const rpc = await client(context);
  await rpc.files.createFolder.mutate({ name: folder });
  const directory = path.join(await dataRoot(), folder);
  for (let i = 0; i < 230; i++)
    await writeFile(path.join(directory, `report-${token}-${i}.txt`), "x");
  const status = page.getByRole("status").filter({ hasText: "matches" });
  await expect(async () => {
    await page.goto(`/search?q=report-${token}`);
    // The count can read "or more" until every layer has answered.
    await expect(status).toHaveText(
      /^Showing 200 of 230( or more)? matches\.$/,
      {
        timeout: 2_000,
      },
    );
  }).toPass();
  await page.getByRole("button", { name: "Show 30 more", exact: true }).click();
  await expect(status).toHaveText("230 matches.");
  const rows = page
    .locator(`[data-entry-path^="${folder}/"]`)
    .filter({ visible: true });
  await rows.last().scrollIntoViewIfNeeded();
  const last = await rows.last().getAttribute("data-entry-path");
  if (!last) throw new Error("The last search result has no path.");
  await rpc.files.delete.mutate({ path: last });
  await expect(status).toHaveText("229 matches.");
  await expect(
    page.locator(`[data-entry-path="${last}"]`).filter({ visible: true }),
  ).toHaveCount(0);
});

test("a page that restarts replaces the results instead of piling onto them", async ({
  page,
  context,
}) => {
  const token = randomUUID().slice(0, 8);
  const folder = `restart-${token}`;
  const rpc = await client(context);
  await rpc.files.createFolder.mutate({ name: folder });
  const directory = path.join(await dataRoot(), folder);
  for (let i = 0; i < 230; i++)
    await writeFile(path.join(directory, `memo-${token}-${i}.txt`), "x");
  const status = page.getByRole("status").filter({ hasText: "matches" });
  await expect(async () => {
    await page.goto(`/search?q=memo-${token}`);
    await expect(status).toHaveText("Showing 200 of 230 matches.", {
      timeout: 2_000,
    });
  }).toPass();
  // Starring changes the caller's history, so the next page cannot continue this one.
  await rpc.catalog.bookmark.mutate({
    path: `${folder}/memo-${token}-229.txt`,
    starred: true,
  });
  const more = page.getByRole("button", { name: "Show 30 more", exact: true });
  await more.click();
  await expect(status).toHaveText("230 matches.");
  await expect(
    page.getByRole("status").filter({ hasText: "rebuilt from the top" }),
  ).toBeVisible();
  const shown = await page
    .locator(`[data-entry-path^="${folder}/"]`)
    .evaluateAll((rows) =>
      rows.map((row) => row.getAttribute("data-entry-path")),
    );
  // Rows render in a window; every rendered one is distinct.
  expect(new Set(shown).size).toBe(shown.length);
  await expect(
    page.getByRole("button", { name: /^Show \d+ more$/ }),
  ).toHaveCount(0);
});

test("a search the server is pacing says to wait a moment, without alarm", async ({
  page,
}) => {
  // The batched answer tRPC sends when the per-person search limit refuses a search.
  const searches = (url: URL) =>
    url.pathname.startsWith("/api/trpc/catalog.search");
  await page.route(searches, (route) => {
    const url = new URL(route.request().url());
    const calls = url.pathname.slice("/api/trpc/".length).split(",").length;
    const error = {
      error: {
        message: "Too many searches.",
        code: -32029,
        data: { code: "TOO_MANY_REQUESTS", httpStatus: 429 },
      },
    };
    return route.fulfill({
      status: 429,
      contentType: "application/json",
      body: JSON.stringify(
        url.searchParams.has("batch")
          ? Array.from({ length: calls }, () => error)
          : error,
      ),
    });
  });
  await page.goto(`/search?q=${randomUUID().slice(0, 8)}`);
  const notice = page
    .getByRole("status")
    .filter({ hasText: "still answering your earlier searches" });
  await expect(notice).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByText("No matching files")).toHaveCount(0);
  await page.unroute(searches);
  await page.getByRole("button", { name: "Search again", exact: true }).click();
  await expect(notice).toBeHidden();
  await expect(page.getByText("No matching files")).toBeVisible();
});
