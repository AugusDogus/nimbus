import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, type Page } from "@playwright/test";
import { z } from "zod";
import { action, client, port, test } from "./helpers";

// A deployment replaces the hashed files of the previous build. A page opened before it still
// asks for the old names, which the server no longer has. These tests take files of the running
// build away after the page loaded, or fail requests for them, as a deployment or a dropped
// connection would.
test.skip(
  process.env.CI !== "true",
  "Only the production build has hashed files a deployment removes.",
);

// Playwright runs from the repository root.
const dist = path.resolve("apps/web/dist");

/** The address of the built file for `source`. */
async function built(source: string) {
  const manifest = z
    .record(z.string(), z.object({ file: z.string() }))
    .parse(
      JSON.parse(
        await readFile(path.join(dist, ".vite/manifest.json"), "utf8"),
      ),
    );
  const file = manifest[source]?.file;
  if (!file) throw new Error(`The build has no file for ${source}.`);
  return `/${file}`;
}

const picker = "app/drive/files/destination-picker/destination-picker.tsx";

/** Answers every request for `files`, with any query, as the server does once they are gone. */
async function remove(page: Page, files: readonly string[]) {
  await page.route(
    (url) => files.includes(url.pathname),
    (route) =>
      route.fulfill({
        status: 404,
        headers: { "Cache-Control": "no-store" },
        body: "Not found",
      }),
  );
}

/** Counts the requests for `file` from now on, with any query and method. */
function count(page: Page, file: string) {
  const seen: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === file)
      seen.push(`${request.method()} ${request.url()}`);
  });
  return seen;
}

/** A new folder holding `files`, and a folder for each name ending in a slash, in `under`. */
async function folder(files: Record<string, string>, under = "") {
  const manifest: unknown = JSON.parse(
    await readFile(path.join(os.tmpdir(), `nimbus-e2e-${port}.json`), "utf8"),
  );
  const { dataRoot } = z
    .object({ dataRoot: z.string().startsWith(os.tmpdir()) })
    .parse(manifest);
  const name = path.posix.join(under, `update-${randomUUID()}`);
  await mkdir(path.join(dataRoot, name));
  for (const [file, body] of Object.entries(files))
    if (file.endsWith("/")) await mkdir(path.join(dataRoot, name, file));
    else await writeFile(path.join(dataRoot, name, file), body);
  return name;
}

const href = (name: string) =>
  `/browse/${name.split("/").map(encodeURIComponent).join("/")}`;

/** Marks this load of the page; a reload clears the mark. */
const mark = (page: Page) =>
  page.evaluate(() => {
    document.documentElement.dataset.updateTest = "this load";
  });
const marked = (page: Page) =>
  page.evaluate(() => document.documentElement.dataset.updateTest ?? "");

const notice = (page: Page, text: string) =>
  page.getByRole("alert").filter({ hasText: text });
const updated = (page: Page) =>
  notice(page, "Nimbus was updated while this page was open.");
const unavailable = (page: Page) =>
  notice(page, "Part of Nimbus could not load.");

const openPicker = (page: Page, isMobile: boolean) =>
  action(page, "a.txt", "Move to…", isMobile);

test("says once that Nimbus was updated when the move picker's code is gone, asks for it twice, and reloads only when asked", async ({
  page,
  isMobile,
}) => {
  const name = await folder({ "a.txt": "a" });
  await page.goto(href(name));
  await mark(page);
  const file = await built(picker);
  await remove(page, [file]);
  const requests = count(page, file);
  await openPicker(page, isMobile);
  await expect(updated(page)).toHaveCount(1);
  // The file itself, then a HEAD request that found it gone.
  expect(requests).toEqual([
    expect.stringMatching(/^GET /),
    expect.stringMatching(/^HEAD /),
  ]);
  await openPicker(page, isMobile);
  // Opening it again asks for nothing more, and says nothing more.
  await page.waitForTimeout(1500);
  expect(requests).toHaveLength(2);
  await expect(updated(page)).toHaveCount(1);
  await expect(page.locator("[data-picker]")).toHaveCount(0);
  expect(await marked(page)).toBe("this load");

  await page.unrouteAll();
  await updated(page).getByRole("button", { name: "Reload" }).click();
  await expect.poll(() => marked(page)).toBe("");
  expect(new URL(page.url()).pathname).toBe(href(name));
  await openPicker(page, isMobile);
  await expect(page.locator("[data-picker]")).toBeVisible();
  await expect(updated(page)).toHaveCount(0);
});

test("says Nimbus was updated when a page's code is gone, instead of reloading by itself", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, "The sidebar link is in a drawer on phones.");
  const name = await folder({ "a.txt": "a" });
  await page.goto(href(name));
  await mark(page);
  await remove(page, [
    await built("routes/_authed/_files/trash.tsx?tsr-split=component"),
  ]);
  await page.getByRole("link", { name: "Trash", exact: true }).click();
  await expect(page.getByText("This page could not open.")).toBeVisible();
  await expect(updated(page)).toHaveCount(1);
  expect(await marked(page)).toBe("this load");
  await page.unrouteAll();
  await updated(page).getByRole("button", { name: "Reload" }).click();
  await expect.poll(() => marked(page)).toBe("");
  expect(new URL(page.url()).pathname).toBe("/trash");
  await expect(page.getByText("This page could not open.")).toHaveCount(0);
});

test("says Nimbus was updated when a preview's code is gone", async ({
  page,
}) => {
  const name = await folder({ "a.txt": "a" });
  await page.goto(href(name));
  await remove(page, [
    await built("app/drive/files/preview/preview-dialog-body.tsx"),
  ]);
  await page
    .locator('[data-entry-name="a.txt"]')
    .filter({ visible: true })
    .click();
  await expect(updated(page)).toBeVisible();
  await expect(page.getByRole("dialog", { name: "a.txt" })).toHaveCount(0);
  await updated(page).getByRole("button", { name: "Dismiss" }).click();
  await expect(updated(page)).toHaveCount(0);
});

test("says Nimbus was updated on a public share page whose preview code is gone", async ({
  browser,
  context,
}) => {
  const name = await folder({ "a.txt": "shared text" });
  const { token } = await (
    await client(context)
  ).shares.create.mutate({ path: name, expiresAt: null });
  const anonymous = await browser.newContext({
    storageState: { cookies: [], origins: [] },
  });
  try {
    const visitor = await anonymous.newPage();
    await visitor.goto(`/s/${token}`);
    await remove(visitor, [
      await built("app/drive/files/preview/file-preview.tsx"),
    ]);
    await visitor.getByRole("button", { name: "a.txt", exact: true }).click();
    await expect(updated(visitor)).toBeVisible();
    await visitor.unrouteAll();
    await updated(visitor).getByRole("button", { name: "Reload" }).click();
    await expect(updated(visitor)).toHaveCount(0);
  } finally {
    await anonymous.close();
  }
});

test("tries again with a new request when the picker's code fails to arrive once", async ({
  page,
  isMobile,
}) => {
  const name = await folder({ "a.txt": "a" });
  await page.goto(href(name));
  const file = await built(picker);
  const requests = count(page, file);
  let failed = false;
  await page.route(
    (url) => url.pathname === file,
    (route) => {
      if (failed || route.request().method() !== "GET") return route.fallback();
      failed = true;
      return route.abort("connectionreset");
    },
  );
  await openPicker(page, isMobile);
  await expect(page.locator("[data-picker]")).toBeVisible();
  // The failed request, a HEAD request that found the file there, and the new request.
  expect(requests).toEqual([
    `GET ${new URL(file, page.url())}`,
    `HEAD ${new URL(file, page.url())}`,
    `GET ${new URL(file, page.url())}?retry=1`,
  ]);
  await expect(unavailable(page)).toHaveCount(0);
  await expect(updated(page)).toHaveCount(0);
});

test("says when the picker's code keeps failing to arrive, without claiming an update, and tries again when asked", async ({
  page,
  isMobile,
}) => {
  const name = await folder({ "a.txt": "a" });
  await page.goto(href(name));
  await mark(page);
  const file = await built(picker);
  const requests = count(page, file);
  await page.route(
    (url) => url.pathname === file,
    (route) =>
      route.request().method() === "GET"
        ? route.abort("connectionreset")
        : route.fallback(),
  );
  await openPicker(page, isMobile);
  await expect(unavailable(page)).toBeVisible();
  // Three tries, each checked once against the server, then nothing more.
  expect(requests.filter((request) => request.startsWith("GET"))).toHaveLength(
    3,
  );
  await page.waitForTimeout(1500);
  expect(requests.filter((request) => request.startsWith("GET"))).toHaveLength(
    3,
  );
  await expect(updated(page)).toHaveCount(0);

  await page.unrouteAll();
  await unavailable(page).getByRole("button", { name: "Try again" }).click();
  await expect(page.locator("[data-picker]")).toBeVisible();
  await expect(unavailable(page)).toHaveCount(0);
  expect(await marked(page)).toBe("this load");
});
