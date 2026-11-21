import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, type Locator, type Page } from "@playwright/test";
import { z } from "zod";
import { action, asMember, client, origin, password, test } from "./helpers";

/**
 * Every transfer the server may have carried out ends in a report the person can reach,
 * whatever the page was doing when its answer arrived, and never claims an outcome Nimbus
 * does not know.
 */

async function dataRoot() {
  const manifest: unknown = JSON.parse(
    await readFile(
      path.join(
        os.tmpdir(),
        `nimbus-e2e-${process.env.NIMBUS_E2E_PORT ?? "3100"}.json`,
      ),
      "utf8",
    ),
  );
  return z
    .object({ dataRoot: z.string().startsWith(os.tmpdir()) })
    .parse(manifest).dataRoot;
}

/** A fresh folder below `under` (the drive root by default) holding `files`. */
async function tree(files: Record<string, string>, under = "") {
  const top = path.posix.join(under, `reports-${randomUUID()}`);
  const root = path.join(await dataRoot(), top);
  await mkdir(root, { recursive: true });
  for (const [file, body] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), body);
  }
  return {
    top,
    names: async (relative = "") =>
      (await readdir(path.join(root, relative))).sort(),
    write: (relative: string, body: string) =>
      writeFile(path.join(root, relative), body),
  };
}

const href = (folder: string) =>
  `/browse/${folder.split("/").map(encodeURIComponent).join("/")}`;
const picker = (page: Page) => page.locator("[data-picker]");
const toasts = (page: Page) => page.locator('[data-slot="toast"]');
/** A toast's button. An error toast stays out of the accessibility tree until focused. */
const button = (toast: Locator, label: string) =>
  toast.locator("button", { hasText: label });
const mod = process.platform === "darwin" ? "Meta" : "Control";

async function select(page: Page, names: readonly string[]) {
  for (const name of names)
    await page
      .getByRole("button", { name, exact: true })
      .click({ modifiers: [mod] });
}

async function moveUp(page: Page, names: readonly string[]) {
  await select(page, names);
  await page
    .getByRole("toolbar", { name: "Selected items" })
    .getByRole("button", { name: "Move up one level" })
    .click();
}

async function moveToSibling(dialog: Locator, top: string, folder: string) {
  await dialog.getByRole("button", { name: "Up one folder" }).click();
  await dialog.locator(`[data-folder-path="${top}/${folder}"]`).click();
  await dialog.getByRole("button", { name: `Move to “${folder}”` }).click();
}

/**
 * Lets the first `count` requests matching `pattern` (the client sends requests made together
 * as one) reach the server, which carries them
 * out, and holds their answers until `release`.
 */
async function holdAnswers(page: Page, pattern: string, count = 1) {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let arrived = 0;
  let seen = () => {};
  const requested = new Promise<void>((resolve) => {
    seen = resolve;
  });
  await page.route(pattern, async (route) => {
    if (arrived >= count) return route.fallback();
    arrived++;
    const response = await route.fetch();
    if (arrived === count) seen();
    await held;
    await route.fulfill({ response });
  });
  return { requested, release };
}

/** Lets matching requests reach the server, which carries them out, and loses each answer. */
async function loseAnswers(page: Page, pattern: string) {
  await page.route(pattern, async (route) => {
    await route.fetch();
    await route.abort("connectionreset");
  });
}

test.describe("moves whose answers arrive late", () => {
  test.skip(
    ({ isMobile }) => isMobile,
    "The selection bar's Move up needs a mouse and a wide window.",
  );
  test.beforeEach(async ({ context, page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await (
      await client(context)
    ).prefs.set.mutate({
      view: "list",
      sortField: "name",
      sortDirection: "asc",
      groupByType: true,
    });
  });

  test("reports a late Move up whose name clashed while a picker is open, with Undo for what moved", async ({
    page,
  }) => {
    const drive = await tree({
      "docs/a.txt": "mine",
      "docs/b.txt": "b",
      "docs/c.txt": "c",
      "a.txt": "theirs",
    });
    await page.goto(href(`${drive.top}/docs`));
    const late = await holdAnswers(page, "**/api/trpc/files.move*");
    await moveUp(page, ["a.txt", "b.txt"]);
    await late.requested;
    await action(page, "c.txt", "Move to…", false);
    const dialog = picker(page);
    await expect(
      dialog.getByRole("heading", { name: "Move “c.txt”" }),
    ).toBeVisible();
    late.release();
    await expect.poll(() => drive.names()).toContain("b.txt");
    await page.waitForTimeout(400);
    // The open picker is not handed a move it did not start.
    await expect(
      dialog.getByRole("heading", { name: "Move “c.txt”" }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    const report = toasts(page).filter({
      hasText: "Moved 1 of 2 items to",
    });
    await expect(report).toContainText("“a.txt” is already there.");
    await expect(button(report, "Keep both")).toBeVisible();
    await expect(button(report, "Rename…")).toBeVisible();
    await button(report, "Undo").click();
    await expect.poll(() => drive.names("docs")).toContain("b.txt");
  });

  test("keeps a late report's Undo within reach while a picker covers the page", async ({
    page,
  }) => {
    const drive = await tree({ "docs/a.txt": "a", "docs/b.txt": "b" });
    await page.goto(href(`${drive.top}/docs`));
    const late = await holdAnswers(page, "**/api/trpc/files.move*");
    await action(page, "a.txt", "Move up one level", false);
    await late.requested;
    await action(page, "b.txt", "Move to…", false);
    const dialog = picker(page);
    await expect(
      dialog.getByRole("heading", { name: "Move “b.txt”" }),
    ).toBeVisible();
    late.release();
    await expect.poll(() => drive.names()).toContain("a.txt");
    // Longer than a report lasts once it can be reached.
    await page.waitForTimeout(11_000);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await toasts(page)
      .filter({ hasText: "Moved “a.txt” to" })
      .getByRole("button", { name: "Undo" })
      .click();
    await expect.poll(() => drive.names("docs")).toEqual(["a.txt", "b.txt"]);
  });

  test("reports a late Move up whose name clashed while the picker asks about its own clash", async ({
    page,
  }) => {
    const drive = await tree({
      "docs/a.txt": "mine",
      "docs/b.txt": "b",
      "docs/c.txt": "mine",
      "a.txt": "theirs",
      "c.txt": "theirs",
    });
    await page.goto(href(`${drive.top}/docs`));
    const late = await holdAnswers(page, "**/api/trpc/files.move*");
    await moveUp(page, ["a.txt", "b.txt"]);
    await late.requested;
    await action(page, "c.txt", "Move to…", false);
    const dialog = picker(page);
    await dialog.getByRole("button", { name: "Up one folder" }).click();
    await dialog
      .getByRole("button", { name: `Move to “${drive.top}”` })
      .click();
    await expect(
      dialog.getByText(`“c.txt” is already in ${drive.top}`),
    ).toBeVisible();
    late.release();
    await expect.poll(() => drive.names()).toContain("b.txt");
    await page.waitForTimeout(400);
    await expect(
      dialog.getByText(`“c.txt” is already in ${drive.top}`),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(
      toasts(page).filter({ hasText: "“c.txt” is already there." }),
    ).toBeVisible();
    const report = toasts(page).filter({
      hasText: "“a.txt” is already there.",
    });
    // Reports stack, the newest in front: hovering them spreads them out.
    await toasts(page).first().hover();
    await button(report, "Undo").click();
    await expect.poll(() => drive.names("docs")).toContain("b.txt");
  });

  test("reports both of two late moves that arrive together, each name clash with its choices", async ({
    page,
  }) => {
    const drive = await tree({
      "docs/a.txt": "mine",
      "docs/b.txt": "b",
      "docs/c.txt": "mine",
      "docs/e.txt": "e",
      "a.txt": "theirs",
      "c.txt": "theirs",
    });
    await page.goto(href(`${drive.top}/docs`));
    const late = await holdAnswers(page, "**/api/trpc/files.move*", 2);
    await moveUp(page, ["a.txt", "b.txt"]);
    await page.keyboard.press("Escape");
    await moveUp(page, ["c.txt", "e.txt"]);
    await late.requested;
    late.release();
    await expect
      .poll(() => drive.names())
      .toEqual(expect.arrayContaining(["b.txt", "e.txt"]));
    // One of them opens the picker at its clash; the other is reported on its own.
    const dialog = picker(page);
    await expect(dialog.getByRole("alertdialog")).toBeVisible();
    await page.waitForTimeout(400);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    for (const clash of ["a.txt", "c.txt"])
      await expect(
        toasts(page).filter({ hasText: `“${clash}” is already there.` }),
      ).toBeVisible();
    for (const clash of ["a.txt", "c.txt"]) {
      await toasts(page).first().hover();
      await button(
        toasts(page).filter({ hasText: `“${clash}” is already there.` }),
        "Undo",
      ).click();
    }
    await expect
      .poll(() => drive.names("docs"))
      .toEqual(["a.txt", "b.txt", "c.txt", "e.txt"]);
  });
});

test("says it could not confirm a move whose answer was lost, and never claims it moved or not", async ({
  page,
  isMobile,
}) => {
  const drive = await tree({ "docs/a.txt": "a", "archive/.keep": "" });
  await page.goto(href(`${drive.top}/docs`));
  await action(page, "a.txt", "Move to…", isMobile);
  await loseAnswers(page, "**/api/trpc/files.move*");
  await moveToSibling(picker(page), drive.top, "archive");
  await expect(picker(page)).toBeHidden();
  // The server did move it; Nimbus cannot know that, and says so.
  expect(await drive.names("archive")).toEqual([".keep", "a.txt"]);
  const report = toasts(page).filter({
    hasText: "Nimbus could not confirm whether “a.txt” moved. Check archive.",
  });
  await expect(report).toBeVisible();
  await expect(report).not.toContainText("Nothing was moved");
  await button(report, "Open folder").click();
  await expect(page).toHaveURL(new RegExp(`${href(`${drive.top}/archive`)}$`));
});

test("says it could not confirm an Undo whose answer was lost", async ({
  page,
  isMobile,
}) => {
  const drive = await tree({ "docs/a.txt": "a", "archive/.keep": "" });
  await page.goto(href(`${drive.top}/docs`));
  await action(page, "a.txt", "Move to…", isMobile);
  await moveToSibling(picker(page), drive.top, "archive");
  await expect(picker(page)).toBeHidden();
  await loseAnswers(page, "**/api/trpc/files.undo*");
  await toasts(page)
    .filter({ hasText: "Moved “a.txt” to archive." })
    .getByRole("button", { name: "Undo" })
    .click();
  // The toast itself: Base UI also announces an error in an alert region of its own.
  await expect(
    toasts(page).filter({
      hasText:
        "Nimbus could not confirm whether “a.txt” was put back. Check docs and archive.",
    }),
  ).toBeVisible();
  await expect(page.getByText("Nothing was undone")).toHaveCount(0);
});

test("keeps a multi-destination report while Details is open, then lets it go", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, "Touch multi-selection is covered elsewhere.");
  const drive = await tree({
    "docs/a.txt": "a",
    "docs/b.txt": "b",
    "one/b.txt": "taken",
    "two/.keep": "",
  });
  await (
    await client(page.context())
  ).prefs.set.mutate({
    view: "list",
    sortField: "name",
    sortDirection: "asc",
    groupByType: true,
  });
  await page.goto(href(`${drive.top}/docs`));
  await select(page, ["a.txt", "b.txt"]);
  await page
    .getByRole("toolbar", { name: "Selected items" })
    .getByRole("button", { name: "Move", exact: true })
    .click();
  const dialog = picker(page);
  await moveToSibling(dialog, drive.top, "one");
  await expect(dialog.getByRole("alertdialog")).toBeVisible();
  await moveToSibling(dialog, drive.top, "two");
  await expect(dialog).toBeHidden();
  const report = toasts(page).filter({
    hasText: "Moved 2 items to 2 folders.",
  });
  await report.getByRole("button", { name: "Details" }).click();
  const details = page.getByRole("dialog", { name: "What was moved" });
  await expect(details).toBeVisible();
  // Longer than the report's own lifetime.
  await page.waitForTimeout(11_000);
  await expect(report).toHaveCount(1);
  await details.getByRole("button", { name: "Close" }).first().click();
  await expect(details).toBeHidden();
  await page.mouse.move(5, 5);
  await expect(report).toHaveCount(0, { timeout: 14_000 });
});

test("asks before signing out while a move runs, and signs out only when confirmed", async ({
  browser,
  context,
  page,
  isMobile,
}) => {
  const account = await asMember(browser, context, page, isMobile, []);
  try {
    const member = account.member;
    const drive = await tree(
      { "docs/a.txt": "a", "archive/.keep": "" },
      account.home,
    );
    let prompted = false;
    member.on("dialog", (prompt) => {
      prompted = true;
      void prompt.dismiss();
    });
    await member.goto(href(`${drive.top}/docs`));
    await action(member, "a.txt", "Move to…", isMobile);
    const late = await holdAnswers(member, "**/api/trpc/files.move*");
    await moveToSibling(picker(member), drive.top, "archive");
    await late.requested;
    await member.keyboard.press("Escape");
    await expect(picker(member)).toBeHidden();
    const signOut = async () => {
      await member.getByRole("button", { name: "Account menu" }).click();
      await member
        .getByRole("menuitem", { name: "Sign out", exact: true })
        .click();
    };
    await signOut();
    const ask = member.getByRole("alertdialog", {
      name: "Sign out while something is still running?",
    });
    await expect(ask).toBeVisible();
    await ask.getByRole("button", { name: "Stay signed in" }).click();
    await expect(ask).toBeHidden();
    late.release();
    await toasts(member)
      .filter({ hasText: "Moved “a.txt” to archive." })
      .getByRole("button", { name: "Undo" })
      .click();
    await expect.poll(() => drive.names("docs")).toEqual(["a.txt"]);

    // With nothing running, signing out asks nothing.
    await signOut();
    await expect(member).toHaveURL(/\/login/);
    expect(prompted).toBe(false);
  } finally {
    await account.memberContext.close();
  }
});

test("starts no move when the code that reports it cannot load", async ({
  page,
  isMobile,
}) => {
  test.skip(
    process.env.CI !== "true",
    "Only the production build has the report's own file.",
  );
  const manifest = z
    .record(z.string(), z.object({ file: z.string() }))
    .parse(
      JSON.parse(
        await readFile(
          path.resolve("apps/web/dist/.vite/manifest.json"),
          "utf8",
        ),
      ),
    );
  const report = manifest["app/drive/files/transfer-report.ts"]?.file;
  if (!report) throw new Error("The build has no file for the report.");
  const drive = await tree({ "docs/a.txt": "a" });
  await page.goto(href(`${drive.top}/docs`));
  await page.route(
    (url) => url.pathname === `/${report}`,
    (route) => route.fulfill({ status: 404, body: "Not found" }),
  );
  await action(page, "a.txt", "Move up one level", isMobile);
  await expect(
    toasts(page).filter({ hasText: "Nothing was moved" }),
  ).toBeVisible();
  expect(await drive.names("docs")).toEqual(["a.txt"]);
});

test.describe("transfers still running", () => {
  test.skip(
    ({ isMobile }) => isMobile,
    "Item menus open as sheets on phones; the desktop menus cover the same paths.",
  );

  test("shows several slow transfers in one entry, which gives way to their reports", async ({
    page,
  }) => {
    const drive = await tree({ "docs/a.txt": "a", "docs/b.txt": "b" });
    await page.goto(href(`${drive.top}/docs`));
    const late = await holdAnswers(page, "**/api/trpc/files.move*", 2);
    await action(page, "a.txt", "Move up one level", false);
    await action(page, "b.txt", "Move up one level", false);
    await late.requested;
    const running = toasts(page).filter({ hasText: "…" });
    await expect(running).toHaveText(/2 items/);
    await expect(toasts(page)).toHaveCount(1);
    late.release();
    await expect(running).toHaveCount(0);
    for (const name of ["a.txt", "b.txt"])
      await expect(
        toasts(page).filter({ hasText: `Moved “${name}” to` }),
      ).toBeVisible();
  });

  test("shows a move that is still running once its picker is closed, and an Undo still running", async ({
    page,
  }) => {
    const drive = await tree({ "docs/a.txt": "a", "archive/.keep": "" });
    await page.goto(href(`${drive.top}/docs`));
    await action(page, "a.txt", "Move to…", false);
    const late = await holdAnswers(page, "**/api/trpc/files.move*");
    await moveToSibling(picker(page), drive.top, "archive");
    await late.requested;
    await page.keyboard.press("Escape");
    await expect(picker(page)).toBeHidden();
    const moving = toasts(page).filter({
      hasText: "Moving “a.txt” to archive…",
    });
    await expect(moving).toBeVisible();
    late.release();
    await expect(moving).toHaveCount(0);
    const report = toasts(page).filter({
      hasText: "Moved “a.txt” to archive.",
    });
    const undoing = await holdAnswers(page, "**/api/trpc/files.undo*");
    await report.getByRole("button", { name: "Undo" }).click();
    await undoing.requested;
    await expect(
      toasts(page).filter({ hasText: "Undoing “a.txt”…" }),
    ).toBeVisible();
    undoing.release();
    await expect(page.getByText("Moved “a.txt” back to docs.")).toBeVisible();
  });
});

test("drops an old clash once its item's Keep both may have gone through", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, "Touch multi-selection is covered elsewhere.");
  const drive = await tree({
    "docs/a.txt": "mine",
    "docs/b.txt": "b",
    "archive/a.txt": "theirs",
  });
  await page.goto(href(`${drive.top}/docs`));
  await select(page, ["a.txt", "b.txt"]);
  await page
    .getByRole("toolbar", { name: "Selected items" })
    .getByRole("button", { name: "Move", exact: true })
    .click();
  const dialog = picker(page);
  await moveToSibling(dialog, drive.top, "archive");
  await expect(dialog.getByText("“a.txt” is already in archive")).toBeVisible();
  await loseAnswers(page, "**/api/trpc/files.move*");
  await dialog.getByRole("button", { name: "Keep both", exact: true }).click();
  // No clash panel left offering Keep both for something that may have moved.
  await expect(dialog).toBeHidden();
  await expect(
    toasts(page).filter({
      hasText: "Nimbus could not confirm whether “a.txt” moved.",
    }),
  ).toBeVisible();
});

test("holds every report while a dialog covers the page, then gives it its time", async ({
  page,
  isMobile,
}) => {
  const drive = await tree({ "docs/a.txt": "a", "docs/b.txt": "b" });
  await page.goto(href(`${drive.top}/docs`));
  await action(page, "a.txt", "Move up one level", isMobile);
  const report = toasts(page).filter({ hasText: "Moved “a.txt” to" });
  await expect(report).toBeVisible();
  // A report already showing, then covered.
  await action(page, "b.txt", "Move to…", isMobile);
  await expect(picker(page)).toBeVisible();
  await page.waitForTimeout(11_000);
  await page.keyboard.press("Escape");
  await expect(picker(page)).toBeHidden();
  await report.getByRole("button", { name: "Undo" }).click();
  const undone = page.getByText("Moved “a.txt” back to docs.");
  await expect(undone).toBeVisible();
  // An Undo confirmation, then covered.
  await action(page, "b.txt", "Move to…", isMobile);
  await expect(picker(page)).toBeVisible();
  await page.waitForTimeout(6_000);
  await page.keyboard.press("Escape");
  await expect(picker(page)).toBeHidden();
  await expect(undone).toBeVisible();
});

test("asks before signing out while an Undo runs", async ({
  browser,
  context,
  page,
  isMobile,
}) => {
  const account = await asMember(browser, context, page, isMobile, []);
  try {
    const member = account.member;
    const drive = await tree(
      { "docs/a.txt": "a", "archive/.keep": "" },
      account.home,
    );
    await member.goto(href(`${drive.top}/docs`));
    await action(member, "a.txt", "Move to…", isMobile);
    await moveToSibling(picker(member), drive.top, "archive");
    await expect(picker(member)).toBeHidden();
    const undoing = await holdAnswers(member, "**/api/trpc/files.undo*");
    await toasts(member)
      .filter({ hasText: "Moved “a.txt” to archive." })
      .getByRole("button", { name: "Undo" })
      .click();
    await undoing.requested;
    await member.getByRole("button", { name: "Account menu" }).click();
    await member
      .getByRole("menuitem", { name: "Sign out", exact: true })
      .click();
    const ask = member.getByRole("alertdialog", {
      name: "Sign out while something is still running?",
    });
    await ask.getByRole("button", { name: "Stay signed in" }).click();
    undoing.release();
    await expect(member.getByText("Moved “a.txt” back to docs.")).toBeVisible();
  } finally {
    await account.memberContext.close();
  }
});

test("asks before stopping impersonation while a move runs", async ({
  browser,
  isMobile,
}) => {
  test.skip(isMobile, "Covered on desktop; the banner is the same on phones.");
  // Its own administrator session, so ending impersonation touches no other test.
  const admin = await browser.newContext({
    storageState: "test-results/.auth/admin.json",
  });
  try {
    const adminPage = await admin.newPage();
    await adminPage.setViewportSize({ width: 1440, height: 900 });
    const created = await adminPage.request.post(
      "/api/auth/admin/create-user",
      {
        headers: { Origin: origin },
        data: {
          name: "Held Member",
          email: `held-${randomUUID().slice(0, 8)}@nimbus.test`,
          password,
          role: "user",
        },
      },
    );
    expect(created.ok()).toBe(true);
    const body: unknown = await created.json();
    const email = z
      .object({ user: z.object({ email: z.string() }) })
      .parse(body).user.email;
    await adminPage.goto("/settings/admin");
    await adminPage
      .getByRole("button", { name: `Actions for ${email}`, exact: true })
      .click();
    await adminPage
      .getByRole("menuitem", { name: "Sign in as user", exact: true })
      .click();
    await adminPage
      .getByRole("alertdialog", { name: `Sign in as ${email}?` })
      .getByRole("button", { name: "Sign in as user", exact: true })
      .click();
    const banner = adminPage.getByRole("region", { name: "Impersonation" });
    await expect(banner).toBeVisible();
    const { home } = await (await client(admin)).access.me.query();
    if (home === null) throw new Error("The member has no home folder.");
    const drive = await tree({ "docs/a.txt": "a", "archive/.keep": "" }, home);
    await adminPage.goto(href(`${drive.top}/docs`));
    await action(adminPage, "a.txt", "Move to…", false);
    const late = await holdAnswers(adminPage, "**/api/trpc/files.move*");
    await moveToSibling(picker(adminPage), drive.top, "archive");
    await late.requested;
    await adminPage.keyboard.press("Escape");
    await banner
      .getByRole("button", { name: "Stop impersonating", exact: true })
      .click();
    const ask = adminPage.getByRole("alertdialog", {
      name: "Stop impersonating while something is still running?",
    });
    await ask.getByRole("button", { name: "Keep impersonating" }).click();
    late.release();
    // Still the member: their Undo works.
    await toasts(adminPage)
      .filter({ hasText: "Moved “a.txt” to archive." })
      .getByRole("button", { name: "Undo" })
      .click();
    await expect.poll(() => drive.names("docs")).toEqual(["a.txt"]);
    await banner
      .getByRole("button", { name: "Stop impersonating", exact: true })
      .click();
    await expect(banner).toBeHidden();
  } finally {
    await admin.close();
  }
});
