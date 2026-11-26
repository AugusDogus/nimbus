import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect } from "@playwright/test";
import sharp from "sharp";
import { z } from "zod";
import { client, port, test, chooseView } from "./helpers";

async function dataRoot() {
  const manifest: unknown = JSON.parse(
    await readFile(path.join(os.tmpdir(), `nimbus-e2e-${port}.json`), "utf8"),
  );
  return z
    .object({ dataRoot: z.string().startsWith(os.tmpdir()) })
    .parse(manifest).dataRoot;
}

test("steps through a folder's previews and renders text formats", async ({
  page,
  context,
  isMobile,
}) => {
  const folder = `previews-${randomUUID()}`;
  await (await client(context)).files.createFolder.mutate({ name: folder });
  const directory = path.join(await dataRoot(), folder);
  await writeFile(
    path.join(directory, "a-table.csv"),
    'city,count\nOslo,3\n"Rome, IT",5\n',
  );
  await writeFile(path.join(directory, "b-config.json"), '{"enabled":true}');
  await writeFile(path.join(directory, "c-notes.txt"), "Plain notes");
  await writeFile(
    path.join(directory, "d-readme.md"),
    "# Release notes\n\n- [x] shipped\n\n[unsafe](javascript:alert(1)) <img src=x onerror=alert(1)>\n",
  );
  await writeFile(
    path.join(directory, "e-main.ts"),
    "export const answer: number = 42; // comment\n",
  );
  await page.goto(`/browse/${folder}`);
  await page
    .locator('[data-entry-name="a-table.csv"]')
    .filter({ visible: true })
    .click();
  let preview = page.getByRole("dialog", { name: "a-table.csv", exact: true });
  await expect(
    preview.getByRole("columnheader", { name: "city" }),
  ).toBeVisible();
  await expect(preview.getByRole("cell", { name: "Rome, IT" })).toBeVisible();
  await expect(preview.getByText("1 of 5")).toBeVisible();
  await expect(
    preview.getByRole("button", { name: "Previous file" }),
  ).toBeDisabled();
  if (isMobile)
    await preview.getByRole("button", { name: "Next file" }).click();
  else await page.keyboard.press("ArrowRight");
  preview = page.getByRole("dialog", { name: "b-config.json", exact: true });
  await expect(preview).toContainText('"enabled"');
  await preview.getByRole("button", { name: "Next file" }).click();
  preview = page.getByRole("dialog", { name: "c-notes.txt", exact: true });
  await expect(preview.locator("pre")).toHaveText("Plain notes");
  await preview.getByRole("button", { name: "Next file" }).click();
  preview = page.getByRole("dialog", { name: "d-readme.md", exact: true });
  await expect(
    preview.getByRole("heading", { name: "Release notes" }),
  ).toBeVisible();
  await expect(preview.getByRole("checkbox")).toBeChecked();
  await expect(preview.locator("img")).toHaveCount(0);
  await expect(preview.locator('a[href^="javascript"]')).toHaveCount(0);
  await expect(preview.getByText("unsafe", { exact: true })).toBeVisible();
  await preview.getByRole("button", { name: "Show source" }).click();
  await expect(preview).toContainText("# Release notes");
  await preview.getByRole("button", { name: "Next file" }).click();
  preview = page.getByRole("dialog", { name: "e-main.ts", exact: true });
  await expect(preview.locator("pre")).toHaveText(
    "export const answer: number = 42; // comment\n",
  );
  // Colors are painted as CSS Custom Highlights, not as elements per token.
  await expect
    .poll(() =>
      page.evaluate(() => CSS.highlights.get("nimbus-code-keyword")?.size ?? 0),
    )
    .toBeGreaterThan(0);
  await expect(preview.locator("pre span")).toHaveCount(0);
  await expect(
    preview.getByRole("button", { name: "Next file" }),
  ).toBeDisabled();
  await preview.getByRole("button", { name: "Previous file" }).click();
  await expect(
    page.getByRole("dialog", { name: "d-readme.md", exact: true }),
  ).toBeVisible();
});

test("edits text files and refuses to overwrite a concurrent change", async ({
  page,
  context,
}) => {
  const folder = `editing-${randomUUID()}`;
  await (await client(context)).files.createFolder.mutate({ name: folder });
  const file = path.join(await dataRoot(), folder, "todo.txt");
  await writeFile(file, "first draft");
  await page.goto(`/browse/${folder}`);
  await page
    .locator('[data-entry-name="todo.txt"]')
    .filter({ visible: true })
    .click();
  const preview = page.getByRole("dialog", { name: "todo.txt", exact: true });
  await preview.getByRole("button", { name: "Edit", exact: true }).click();
  // Focus moves into the text, and back to Edit when the editor closes.
  await expect(
    preview.getByRole("textbox", { name: "File contents" }),
  ).toBeFocused();
  await preview
    .getByRole("textbox", { name: "File contents" })
    .fill("second draft");
  await preview.getByRole("button", { name: "Save", exact: true }).click();
  await expect(preview.locator("pre")).toHaveText("second draft");
  await expect(
    preview.getByRole("button", { name: "Edit", exact: true }),
  ).toBeFocused();
  expect(await readFile(file, "utf8")).toBe("second draft");

  await preview.getByRole("button", { name: "Edit", exact: true }).click();
  await writeFile(file, "changed in another app");
  await preview
    .getByRole("textbox", { name: "File contents" })
    .fill("my overwrite");
  await preview.getByRole("button", { name: "Save", exact: true }).click();
  await expect(preview.getByRole("alert")).toContainText(
    "changed after you started editing",
  );
  await expect(
    preview.getByRole("textbox", { name: "File contents" }),
  ).toHaveValue("my overwrite");
  expect(await readFile(file, "utf8")).toBe("changed in another app");
});

test("keeps an edit tied to the version it started from after the tab regains focus", async ({
  page,
  context,
}) => {
  const folder = `editing-focus-${randomUUID()}`;
  await (await client(context)).files.createFolder.mutate({ name: folder });
  const file = path.join(await dataRoot(), folder, "notes.txt");
  await writeFile(file, "original");
  await page.goto(`/browse/${folder}`);
  await page
    .locator('[data-entry-name="notes.txt"]')
    .filter({ visible: true })
    .click();
  const preview = page.getByRole("dialog", { name: "notes.txt", exact: true });
  await preview.getByRole("button", { name: "Edit", exact: true }).click();
  const editor = preview.getByRole("textbox", { name: "File contents" });
  await editor.fill("my edits");
  // Someone else saves, and the tab regains focus, which refetches stale queries.
  await writeFile(file, "their change");
  // Before the fix this refetch replaced the version the save checked against.
  const refetched = page
    .waitForResponse(
      (response) =>
        response.url().includes("/api/files/download") &&
        response.request().method() === "GET",
      { timeout: 3_000 },
    )
    .catch(() => null);
  await page.evaluate(() =>
    document.dispatchEvent(new Event("visibilitychange", { bubbles: true })),
  );
  await refetched;
  await preview.getByRole("button", { name: "Save", exact: true }).click();
  await expect(preview.getByRole("alert")).toContainText(
    "changed after you started editing",
  );
  await expect(editor).toHaveValue("my edits");
  expect(await readFile(file, "utf8")).toBe("their change");

  // Overwriting is an explicit choice, and the replaced text stays in the version history.
  await preview
    .getByRole("button", { name: "Overwrite with my edits", exact: true })
    .click();
  await expect(preview.locator("pre")).toHaveText("my edits");
  expect(await readFile(file, "utf8")).toBe("my edits");

  // Discarding instead shows the file as it is now.
  await preview.getByRole("button", { name: "Edit", exact: true }).click();
  await editor.fill("discard me");
  await writeFile(file, "newest");
  await preview.getByRole("button", { name: "Save", exact: true }).click();
  await expect(preview.getByRole("alert")).toContainText(
    "changed after you started editing",
  );
  await preview
    .getByRole("button", { name: "Discard my edits", exact: true })
    .click();
  await expect(preview.locator("pre")).toHaveText("newest");
  expect(await readFile(file, "utf8")).toBe("newest");
});

test("shows text that is not UTF-8 as read-only", async ({ page, context }) => {
  const folder = `editing-latin1-${randomUUID()}`;
  await (await client(context)).files.createFolder.mutate({ name: folder });
  const bytes = Buffer.from([0x63, 0x61, 0x66, 0xe9]);
  await writeFile(path.join(await dataRoot(), folder, "legacy.txt"), bytes);
  await page.goto(`/browse/${folder}`);
  await page
    .locator('[data-entry-name="legacy.txt"]')
    .filter({ visible: true })
    .click();
  const preview = page.getByRole("dialog", { name: "legacy.txt", exact: true });
  await expect(preview.getByText("This file is not UTF-8 text")).toBeVisible();
  await expect(
    preview.getByRole("button", { name: "Edit", exact: true }),
  ).toHaveCount(0);
});

test("keeps text typed while a save is in flight", async ({
  page,
  context,
}) => {
  const folder = `editing-inflight-${randomUUID()}`;
  await (await client(context)).files.createFolder.mutate({ name: folder });
  const file = path.join(await dataRoot(), folder, "draft.txt");
  await writeFile(file, "a");
  await page.goto(`/browse/${folder}`);
  await page
    .locator('[data-entry-name="draft.txt"]')
    .filter({ visible: true })
    .click();
  const preview = page.getByRole("dialog", { name: "draft.txt", exact: true });
  await preview.getByRole("button", { name: "Edit", exact: true }).click();
  const editor = preview.getByRole("textbox", { name: "File contents" });
  await editor.fill("ab");
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/files/content?**", async (route) => {
    await held;
    await route.continue();
  });
  await preview.getByRole("button", { name: "Save", exact: true }).click();
  await editor.press("End");
  await editor.pressSequentially("c");
  release();
  await expect.poll(() => readFile(file, "utf8")).toBe("ab");
  // The editor stays open with the newer text, still unsaved.
  await expect(editor).toHaveValue("abc");
  await page.unroute("**/api/files/content?**");
  await preview.getByRole("button", { name: "Save", exact: true }).click();
  await expect(preview.locator("pre")).toHaveText("abc");
  expect(await readFile(file, "utf8")).toBe("abc");
});

test("serves cached thumbnails that revalidate and work on public links", async ({
  page,
  context,
  browser,
  isMobile,
}) => {
  const folder = `thumbnails-${randomUUID()}`;
  const rpc = await client(context);
  await rpc.files.createFolder.mutate({ name: folder });
  const image = path.join(await dataRoot(), folder, "photo.png");
  await sharp({
    create: { width: 640, height: 320, channels: 3, background: "#4477aa" },
  })
    .png()
    .toFile(image);
  const url = `/api/files/thumbnail?path=${encodeURIComponent(`${folder}/photo.png`)}`;
  const first = await context.request.get(url);
  expect(first.status()).toBe(200);
  expect(first.headers()["content-type"]).toBe("image/webp");
  expect(first.headers()["cache-control"]).toBe("private, no-cache");
  const etag = first.headers()["etag"];
  expect(etag).toMatch(/^"[a-f0-9]{64}"$/);
  expect(await sharp(await first.body()).metadata()).toMatchObject({
    width: 256,
    height: 128,
  });
  expect(
    (
      await context.request.get(url, { headers: { "If-None-Match": etag } })
    ).status(),
  ).toBe(304);

  const anonymous = await browser.newContext({
    storageState: { cookies: [], origins: [] },
  });
  expect((await anonymous.request.get(url)).status()).toBe(401);
  const { token } = await rpc.shares.create.mutate({
    path: folder,
    expiresAt: null,
  });
  const shared = await anonymous.request.get(
    `/api/share/${token}/thumbnail?path=photo.png`,
  );
  expect(shared.status()).toBe(200);
  expect(
    (
      await anonymous.request.get(
        `/api/share/${token}/thumbnail?path=../outside.png`,
      )
    ).status(),
  ).toBeGreaterThanOrEqual(400);
  // A password-protected link's thumbnails load once it is unlocked.
  const locked = await rpc.shares.create.mutate({
    path: folder,
    expiresAt: null,
    password: "thumbnail-pass-42",
  });
  const lockedURL = `/api/share/${locked.token}/thumbnail?path=photo.png`;
  expect((await anonymous.request.get(lockedURL)).status()).toBe(401);
  expect(
    (
      await anonymous.request.post(`/api/share/${locked.token}`, {
        data: { password: "thumbnail-pass-42" },
      })
    ).status(),
  ).toBe(200);
  expect((await anonymous.request.get(lockedURL)).status()).toBe(200);
  await anonymous.close();

  await page.goto(`/browse/${folder}`);
  await chooseView(page, "Grid view", isMobile);
  const thumbnail = page
    .locator('[data-entry-name="photo.png"] img')
    .filter({ visible: true });
  await expect(thumbnail).toBeVisible();
  await expect
    .poll(() =>
      thumbnail.evaluate(
        (element) =>
          element instanceof HTMLImageElement &&
          element.complete &&
          element.naturalWidth,
      ),
    )
    .toBe(256);
  await chooseView(page, "List view", isMobile);
  await expect
    .poll(async () => (await rpc.prefs.get.query()).view)
    .toBe("list");
});

test("the editor says the same limits as the server: open up to 1 MB, save up to 5 MB", async ({
  page,
  context,
}) => {
  const folder = `editing-limits-${randomUUID()}`;
  await (await client(context)).files.createFolder.mutate({ name: folder });
  const directory = path.join(await dataRoot(), folder);
  await writeFile(path.join(directory, "big.txt"), "x".repeat(1024 * 1024 + 1));
  await writeFile(path.join(directory, "small.txt"), "small");
  await page.goto(`/browse/${folder}`);
  await page
    .locator('[data-entry-name="big.txt"]')
    .filter({ visible: true })
    .click();
  const big = page.getByRole("dialog", { name: "big.txt", exact: true });
  await expect(
    big.getByText("Files up to 1 MB can be edited here."),
  ).toBeVisible();
  await expect(
    big.getByRole("button", { name: "Edit", exact: true }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");

  await page
    .locator('[data-entry-name="small.txt"]')
    .filter({ visible: true })
    .click();
  const small = page.getByRole("dialog", { name: "small.txt", exact: true });
  await small.getByRole("button", { name: "Edit", exact: true }).click();
  const editor = small.getByRole("textbox", { name: "File contents" });
  await editor.evaluate((element) => {
    if (!(element instanceof HTMLTextAreaElement)) return;
    // React tracks the value; set it through the native setter so the change registers.
    const setter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )?.set;
    setter?.call(element, "y".repeat(5 * 1024 * 1024 + 1));
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
  let saved = false;
  page.on("request", (request) => {
    if (request.url().includes("/api/files/content")) saved = true;
  });
  await small.getByRole("button", { name: "Save", exact: true }).click();
  await expect(small.getByRole("alert")).toContainText(
    "Edited files can be at most 5 MB",
  );
  expect(saved).toBe(false);
  expect(await readFile(path.join(directory, "small.txt"), "utf8")).toBe(
    "small",
  );
});
