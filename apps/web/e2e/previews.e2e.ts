import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect } from "@playwright/test";
import sharp from "sharp";
import { z } from "zod";
import { client, port, test } from "./helpers";

async function dataRoot() {
  const manifest: unknown = JSON.parse(await readFile(path.join(os.tmpdir(), `nimbus-e2e-${port}.json`), "utf8"));
  return z.object({ dataRoot: z.string().startsWith(os.tmpdir()) }).parse(manifest).dataRoot;
}

test("steps through a folder's previews and renders text formats", async ({ page, context, isMobile }) => {
  const folder = `previews-${randomUUID()}`;
  await (await client(context)).files.createFolder.mutate({ name: folder });
  const directory = path.join(await dataRoot(), folder);
  await writeFile(path.join(directory, "a-table.csv"), 'city,count\nOslo,3\n"Rome, IT",5\n');
  await writeFile(path.join(directory, "b-config.json"), '{"enabled":true}');
  await writeFile(path.join(directory, "c-notes.txt"), "Plain notes");
  await page.goto(`/browse/${folder}`);
  await page.locator('[data-entry-name="a-table.csv"]').filter({ visible: true }).click();
  let preview = page.getByRole("dialog", { name: "a-table.csv", exact: true });
  await expect(preview.getByRole("columnheader", { name: "city" })).toBeVisible();
  await expect(preview.getByRole("cell", { name: "Rome, IT" })).toBeVisible();
  await expect(preview.getByText("1 of 3")).toBeVisible();
  await expect(preview.getByRole("button", { name: "Previous file" })).toBeDisabled();
  if (isMobile) await preview.getByRole("button", { name: "Next file" }).click();
  else await page.keyboard.press("ArrowRight");
  preview = page.getByRole("dialog", { name: "b-config.json", exact: true });
  await expect(preview).toContainText('"enabled"');
  await preview.getByRole("button", { name: "Next file" }).click();
  preview = page.getByRole("dialog", { name: "c-notes.txt", exact: true });
  await expect(preview.locator("pre")).toHaveText("Plain notes");
  await expect(preview.getByRole("button", { name: "Next file" })).toBeDisabled();
  await preview.getByRole("button", { name: "Previous file" }).click();
  await expect(page.getByRole("dialog", { name: "b-config.json", exact: true })).toBeVisible();
});

test("edits text files and refuses to overwrite a concurrent change", async ({ page, context }) => {
  const folder = `editing-${randomUUID()}`;
  await (await client(context)).files.createFolder.mutate({ name: folder });
  const file = path.join(await dataRoot(), folder, "todo.txt");
  await writeFile(file, "first draft");
  await page.goto(`/browse/${folder}`);
  await page.locator('[data-entry-name="todo.txt"]').filter({ visible: true }).click();
  const preview = page.getByRole("dialog", { name: "todo.txt", exact: true });
  await preview.getByRole("button", { name: "Edit", exact: true }).click();
  await preview.getByRole("textbox", { name: "File contents" }).fill("second draft");
  await preview.getByRole("button", { name: "Save", exact: true }).click();
  await expect(preview.locator("pre")).toHaveText("second draft");
  expect(await readFile(file, "utf8")).toBe("second draft");

  await preview.getByRole("button", { name: "Edit", exact: true }).click();
  await writeFile(file, "changed in another app");
  await preview.getByRole("textbox", { name: "File contents" }).fill("my overwrite");
  await preview.getByRole("button", { name: "Save", exact: true }).click();
  await expect(preview.getByRole("alert")).toContainText("changed after you opened it");
  await expect(preview.getByRole("textbox", { name: "File contents" })).toHaveValue("my overwrite");
  expect(await readFile(file, "utf8")).toBe("changed in another app");
});

test("serves cached thumbnails that revalidate and work on public links", async ({ page, context, browser }) => {
  const folder = `thumbnails-${randomUUID()}`;
  const rpc = await client(context);
  await rpc.files.createFolder.mutate({ name: folder });
  const image = path.join(await dataRoot(), folder, "photo.png");
  await sharp({ create: { width: 640, height: 320, channels: 3, background: "#4477aa" } }).png().toFile(image);
  const url = `/api/files/thumbnail?path=${encodeURIComponent(`${folder}/photo.png`)}`;
  const first = await context.request.get(url);
  expect(first.status()).toBe(200);
  expect(first.headers()["content-type"]).toBe("image/webp");
  expect(first.headers()["cache-control"]).toBe("private, no-cache");
  const etag = first.headers()["etag"];
  expect(etag).toMatch(/^"[a-f0-9]{64}"$/);
  expect(await sharp(await first.body()).metadata()).toMatchObject({ width: 256, height: 128 });
  expect((await context.request.get(url, { headers: { "If-None-Match": etag } })).status()).toBe(304);

  const anonymous = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  expect((await anonymous.request.get(url)).status()).toBe(401);
  const { token } = await rpc.shares.create.mutate({ path: folder, expiresAt: null });
  const shared = await anonymous.request.get(`/api/files/thumbnail?share=${token}&path=photo.png`);
  expect(shared.status()).toBe(200);
  expect((await anonymous.request.get(`/api/files/thumbnail?share=${token}&path=../outside.png`)).status()).toBeGreaterThanOrEqual(400);
  await anonymous.close();

  await page.goto(`/browse/${folder}`);
  await page.getByRole("radio", { name: "Grid view", exact: true }).click();
  const thumbnail = page.locator('[data-entry-name="photo.png"] img').filter({ visible: true });
  await expect(thumbnail).toBeVisible();
  await expect.poll(() => thumbnail.evaluate((element) => element instanceof HTMLImageElement && element.complete && element.naturalWidth)).toBe(256);
  await page.getByRole("radio", { name: "List view", exact: true }).click();
  await expect.poll(async () => (await rpc.prefs.get.query()).view).toBe("list");
});
