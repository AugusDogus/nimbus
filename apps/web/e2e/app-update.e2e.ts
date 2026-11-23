import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, type Page } from "@playwright/test";
import { z } from "zod";
import { FileListing } from "@nimbus/api/file-listing";
import { action, asMember, client, port, test } from "./helpers";

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

/** Answers requests for every built file as the server does after a deployment. */
async function deploy(page: Page) {
  await page.route(
    (url) => url.pathname.startsWith("/assets/"),
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
  page
    .evaluate(() => document.documentElement.dataset.updateTest ?? "")
    .catch(() => "while loading");

/**
 * The notice in the corner, in its live region: polite for an update, assertive for code that did
 * not arrive. Neither region has a role, so no empty status or alert is on the page.
 */
const notice = (page: Page, live: "polite" | "assertive", text: string) =>
  page
    .locator(`[aria-live="${live}"] [data-slot="code-load-notice"]`)
    .filter({ hasText: text });
const updated = (page: Page) =>
  notice(page, "polite", "Nimbus has been updated.");
const unavailable = (page: Page) =>
  notice(page, "assertive", "Part of Nimbus could not load.");

const openPicker = (page: Page, isMobile: boolean) =>
  action(page, "a.txt", "Move to…", isMobile);

const open = (page: Page, name: string) =>
  page.locator(`[data-entry-name="${name}"]`).filter({ visible: true }).click();

test("says Nimbus has been updated when the move picker's code is gone, asks for it twice, says so again after Dismiss, and reloads only when asked", async ({
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
  await updated(page).getByRole("button", { name: "Dismiss" }).click();
  await expect(updated(page)).toHaveCount(0);
  // Opening it again fails again, which says so again, and asks for nothing more.
  await openPicker(page, isMobile);
  await expect(updated(page)).toHaveCount(1);
  await page.waitForTimeout(1500);
  expect(requests).toHaveLength(2);
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

test("opens a page in full when its code is gone, and only once when that lands on the same build", async ({
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
  await expect.poll(() => marked(page)).toBe("");
  expect(new URL(page.url()).pathname).toBe("/trash");

  // The page that loaded runs the same build, as a cache that kept it would serve, so the
  // Trash page's code is gone again. It says so instead of reloading again.
  await expect(page.getByText("This page could not open.")).toBeVisible();
  await expect(updated(page)).toHaveCount(1);
  await mark(page);
  await page.waitForTimeout(1500);
  expect(await marked(page)).toBe("this load");

  await page.unrouteAll();
  await updated(page).getByRole("button", { name: "Reload" }).click();
  await expect.poll(() => marked(page)).toBe("");
  expect(new URL(page.url()).pathname).toBe("/trash");
  await expect(page.getByText("This page could not open.")).toHaveCount(0);
  await expect(updated(page)).toHaveCount(0);
});

test("says Nimbus has been updated when a preview's code is gone", async ({
  page,
}) => {
  const name = await folder({ "a.txt": "a" });
  await page.goto(href(name));
  await remove(page, [
    await built("app/drive/files/preview/preview-dialog-body.tsx"),
  ]);
  await open(page, "a.txt");
  await expect(updated(page)).toBeVisible();
  await expect(page.getByRole("dialog", { name: "a.txt" })).toHaveCount(0);
  await updated(page).getByRole("button", { name: "Dismiss" }).click();
  await expect(updated(page)).toHaveCount(0);
});

test("says Nimbus has been updated on a public share page whose preview code is gone", async ({
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

test("says when the picker's code keeps failing to arrive, without claiming an update, and that reloading is needed", async ({
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

  // Trying again cannot help once the browser holds a failure, so the notice offers Reload.
  await expect(
    unavailable(page).getByRole("button", { name: "Try again" }),
  ).toHaveCount(0);
  expect(await marked(page)).toBe("this load");
  await page.unrouteAll();
  await unavailable(page).getByRole("button", { name: "Reload" }).click();
  await expect.poll(() => marked(page)).toBe("");
  await openPicker(page, isMobile);
  await expect(page.locator("[data-picker]")).toBeVisible();
  await expect(unavailable(page)).toHaveCount(0);
});

test("says reloading is needed, above the preview, when a file the preview's code imports fails to arrive once", async ({
  page,
}) => {
  const name = await folder({
    "d.md": "# Heading\n\n```ts\nconst x = 1;\n```\n",
  });
  await page.goto(href(name));
  await mark(page);
  // The markdown view imports the code view; the browser keeps that file's failure, so retrying
  // the markdown view with new requests can never load it.
  const dependency = await built("app/drive/files/preview/code-view.tsx");
  let failed = false;
  await page.route(
    (url) => url.pathname === dependency,
    (route) => {
      if (failed || route.request().method() !== "GET") return route.fallback();
      failed = true;
      return route.abort("connectionreset");
    },
  );
  await open(page, "d.md");
  const preview = page.getByRole("dialog", { name: "d.md" });
  await expect(unavailable(page)).toBeVisible();
  // One message, in the corner, above the preview; none of its own in the preview.
  await expect(preview).toBeVisible();
  await expect(preview.getByText("could not load")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Try again" })).toHaveCount(0);
  await expect(updated(page)).toHaveCount(0);
  await unavailable(page).getByRole("button", { name: "Reload" }).click();
  await expect.poll(() => marked(page)).toBe("");
  await open(page, "d.md");
  await expect(preview.getByRole("heading", { name: "Heading" })).toBeVisible();
  await expect(unavailable(page)).toHaveCount(0);
});

/** Every answer from the API names another build than this page's. */
async function answerFromAnotherBuild(page: Page) {
  await page.route("**/api/trpc/**", async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      headers: {
        ...response.headers(),
        "nimbus-build": "/assets/index-newer.js",
      },
    });
  });
}

/** The page's own entry script, and the HEAD requests for it from now on. */
async function entryChecks(page: Page) {
  const entry = await page.evaluate(
    () =>
      new URL(
        document.querySelector<HTMLScriptElement>('script[type="module"][src]')
          ?.src ?? "",
      ).pathname,
  );
  const checks = count(page, entry);
  return { entry, checks };
}

/**
 * Deploys a newer build as this page finds out: answers from the API name it, and checking this
 * page's entry finds it gone. The entry still loads for a page that asks for it, as from a cache
 * that kept it. Returns the checks of the entry from now on, and waits for the next one.
 */
async function deployNewerBuild(page: Page) {
  const { entry, checks } = await entryChecks(page);
  await page.route(
    (url) => url.pathname === entry,
    (route) =>
      route.request().method() === "HEAD"
        ? route.fulfill({
            status: 404,
            headers: { "Cache-Control": "no-store" },
            body: "Not found",
          })
        : route.fallback(),
  );
  await answerFromAnotherBuild(page);
  const checked = () =>
    page.waitForResponse(
      (response) =>
        response.request().method() === "HEAD" &&
        new URL(response.url()).pathname === entry,
    );
  return { checks, checked };
}

test("opens the next page in full once Nimbus has been updated, saying nothing, and not again from the same build", async ({
  page,
}) => {
  const name = await folder({ "sub/": "" });
  await page.goto(href(name));
  await mark(page);
  const { checks, checked } = await deployNewerBuild(page);
  // Opening a folder asks the server for its listing, whose answer tells of the update.
  const first = checked();
  await open(page, "sub");
  await expect(page).toHaveURL(new RegExp(`${href(name)}/sub$`));
  expect((await first).status()).toBe(404);
  // That move started before the update was known.
  expect(await marked(page)).toBe("this load");
  expect(checks).toEqual([expect.stringMatching(/^HEAD /)]);

  // Back is a move to another page: it opens in full, with nothing to say. The page that
  // loads runs the same build, so it learns of the update again as it starts.
  const again = checked();
  await page.goBack();
  await expect.poll(() => marked(page)).toBe("");
  expect(new URL(page.url()).pathname).toBe(href(name));
  await expect(page.locator('[data-entry-name="sub"]').first()).toBeVisible();
  expect((await again).status()).toBe(404);
  await expect(updated(page)).toHaveCount(0);

  // Moving on from it stays in the page instead of reloading again.
  await mark(page);
  await open(page, "sub");
  await expect(page).toHaveURL(new RegExp(`${href(name)}/sub$`));
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`${href(name)}$`));
  await page.waitForTimeout(500);
  expect(await marked(page)).toBe("this load");
  await expect(updated(page)).toHaveCount(0);
  // Live update streams stay open through the handler until the page closes.
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test("moves to another page in place while an upload runs after an update, and opens the next in full once it is done", async ({
  page,
  context,
}) => {
  const name = await folder({ "sub/": "" });
  const rpc = await client(context);
  await page.goto(href(name));
  const { checked } = await deployNewerBuild(page);
  const known = checked();
  await open(page, "sub");
  await expect(page).toHaveURL(new RegExp(`${href(name)}/sub$`));
  await known;
  await mark(page);

  const started = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  await page.route("**/api/upload**", async (route) => {
    // Small uploads send their bytes with the creation POST; larger ones use PATCH.
    if (["POST", "PATCH"].includes(route.request().method())) {
      started.resolve();
      await resume.promise;
    }
    await route.continue();
  });
  await page
    .locator('input[type="file"]')
    .first()
    .setInputFiles({
      name: "kept.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("kept"),
    });
  await started.promise;
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`${href(name)}$`));
  await expect(
    page.getByRole("button", { name: "Cancel upload", exact: true }),
  ).toBeVisible();
  expect(await marked(page)).toBe("this load");
  resume.resolve();
  await expect
    .poll(async () =>
      FileListing.entries(
        await rpc.files.list.query({ path: `${name}/sub` }),
      ).map((item) => item.name),
    )
    .toEqual(["kept.txt"]);
  await expect(
    page.getByRole("button", { name: "Cancel upload", exact: true }),
  ).toHaveCount(0);
  expect(await marked(page)).toBe("this load");
  await expect(updated(page)).toHaveCount(0);

  // With nothing left to lose, the next page opens in full.
  await open(page, "sub");
  await expect.poll(() => marked(page)).toBe("");
  expect(new URL(page.url()).pathname).toBe(`${href(name)}/sub`);
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test("says Nimbus has been updated when the split view's code is gone, stays in the page, and reloads when asked", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, "Phones show one folder at a time.");
  const name = await folder({ "sub/": "" });
  await remove(page, [await built("app/drive/files/split/split-view.tsx")]);
  await page.goto(href(name));
  await mark(page);
  const toggle = page.getByRole("button", { name: "Split view" });
  await toggle.click();
  await expect(updated(page)).toBeVisible();
  // Opening a split view changes the address's search, not its page: nothing reloads.
  expect(await marked(page)).toBe("this load");
  expect(new URL(page.url()).searchParams.has("right")).toBe(false);
  await updated(page).getByRole("button", { name: "Dismiss" }).click();
  await expect(updated(page)).toHaveCount(0);
  await toggle.click();
  await expect(updated(page)).toBeVisible();

  await page.unrouteAll();
  await updated(page).getByRole("button", { name: "Reload" }).click();
  await expect.poll(() => marked(page)).toBe("");
  await toggle.click();
  await expect(page.locator('[data-pane="right"]')).toBeVisible();
  await expect(updated(page)).toHaveCount(0);
});

test("does not open the next page in full when an answer names another build but this page's entry is still there", async ({
  page,
}) => {
  const name = await folder({ "sub/": "" });
  await page.goto(href(name));
  await mark(page);
  const { checks } = await entryChecks(page);
  await answerFromAnotherBuild(page);
  const checked = page.waitForResponse(
    (response) => response.request().method() === "HEAD",
  );
  await open(page, "sub");
  await expect(page).toHaveURL(new RegExp(`${href(name)}/sub$`));
  expect((await checked).status()).toBe(200);
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`${href(name)}$`));
  await page.waitForTimeout(500);
  expect(await marked(page)).toBe("this load");
  await expect(updated(page)).toHaveCount(0);
  expect(checks).toHaveLength(1);
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test("signs out of a page whose code is gone", async ({
  browser,
  context,
  page,
  isMobile,
}) => {
  const account = await asMember(browser, context, page, isMobile, []);
  try {
    const member = account.member;
    const name = await folder({ "a.txt": "a" }, account.home);
    await member.goto(href(name));
    await deploy(member);
    await member.getByRole("button", { name: "Account menu" }).click();
    await member
      .getByRole("menuitem", { name: "Sign out", exact: true })
      .click();
    await expect(member).toHaveURL(/\/login/);
    await member.unrouteAll();
    await member.goto(href(name));
    await expect(member).toHaveURL(/\/login/);
  } finally {
    await account.memberContext.close();
  }
});

test("asks before signing out of a page whose code is gone while a move runs, and stays signed in when the server refuses", async ({
  browser,
  context,
  page,
  isMobile,
}) => {
  const account = await asMember(browser, context, page, isMobile, []);
  try {
    const member = account.member;
    const name = await folder({ "a.txt": "a", "b.txt": "b" }, account.home);
    await member.goto(href(name));
    // Loads what reports a move before the deployment takes the files away.
    await openPicker(member, isMobile);
    await expect(member.locator("[data-picker]")).toBeVisible();
    await member.keyboard.press("Escape");
    await deploy(member);
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await member.route("**/api/trpc/files.move*", async (route) => {
      const response = await route.fetch();
      await held;
      // The page signed out, and left, before the answer arrived.
      await route.fulfill({ response }).catch(() => undefined);
    });
    const moving = member.waitForRequest("**/api/trpc/files.move*");
    await action(member, "a.txt", "Move up one level", isMobile);
    await moving;

    const signOut = async () => {
      await member.getByRole("button", { name: "Account menu" }).click();
      await member
        .getByRole("menuitem", { name: "Sign out", exact: true })
        .click();
    };
    const ask = member.getByRole("alertdialog", {
      name: "Sign out while something is still running?",
    });
    await signOut();
    await expect(ask).toBeVisible();
    await ask.getByRole("button", { name: "Stay signed in" }).click();
    await expect(ask).toBeHidden();

    // A refusal leaves the session and the page as they are, and says so.
    await member.route("**/api/auth/sign-out", (route) =>
      route.fulfill({ status: 500, body: "{}" }),
    );
    await signOut();
    await ask.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(
      member
        .locator('[data-slot="toast"]')
        .filter({ hasText: "You are still signed in." }),
    ).toBeVisible();
    expect(new URL(member.url()).pathname).toBe(href(name));
    await member.unroute("**/api/auth/sign-out");

    await signOut();
    await ask.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(member).toHaveURL(/\/login/);
    release();
    await member.unrouteAll();
    await member.goto(href(name));
    await expect(member).toHaveURL(/\/login/);
  } finally {
    await account.memberContext.close();
  }
});
