import { randomUUID } from "node:crypto";
import { expect, type BrowserContext, type Page } from "@playwright/test";
import { FileListing } from "@nimbus/api/file-listing";
import {
  asMember,
  client,
  login,
  origin,
  password,
  test,
  whenCanCreate,
} from "./helpers";

/**
 * New is on every files page, in one place, so the sidebar never changes shape. On a folder it
 * creates there; on any other files page it creates in the Files home, the folder Files opens,
 * then goes there and highlights what arrives. With nowhere to create, it stays, disabled, and
 * says why.
 */

const filesPages = [
  ["/", "Files"],
  ["/shared", "Shared"],
  ["/recent", "Recent"],
  ["/starred", "Starred"],
  ["/trash", "Trash"],
  ["/search?q=alpha", "Search: alpha"],
] as const;

const newButton = (page: Page, isMobile: boolean) =>
  page.getByRole("button", {
    name: isMobile ? "New file or folder" : "New",
    exact: true,
  });

const newItem = (page: Page, isMobile: boolean, name: string) =>
  page.getByRole(isMobile ? "button" : "menuitem", { name, exact: true });

/** Records, across in-app navigation, each item highlighted as just arrived. */
async function watchArrivals(page: Page) {
  await page.evaluate(() => {
    const seen = new Set<string>();
    Object.assign(window, { arrivedNames: seen });
    const note = () => {
      for (const row of document.querySelectorAll(
        "[data-arrived][data-entry-name]",
      ))
        seen.add(row.getAttribute("data-entry-name") ?? "");
    };
    new MutationObserver(note).observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["data-arrived"],
    });
  });
}

const arrived = (page: Page) =>
  page.evaluate(() =>
    "arrivedNames" in window && window.arrivedNames instanceof Set
      ? [...window.arrivedNames].map(String)
      : [],
  );

async function names(context: BrowserContext, path: string) {
  const rpc = await client(context);
  return FileListing.entries(await rpc.files.list.query({ path })).map(
    (entry) => entry.name,
  );
}

test("New is in the same place, ready, on every files page", async ({
  page,
  isMobile,
}) => {
  const create = newButton(page, isMobile);
  let first: { x: number; y: number; width: number; height: number } | null =
    null;
  for (const [address, heading] of filesPages) {
    await page.goto(address);
    await expect(
      page.getByRole("heading", { name: heading, exact: true }),
    ).toBeVisible();
    await expect(create).toBeVisible();
    await expect(create).toBeEnabled();
    await expect(create).not.toHaveAttribute("aria-disabled", "true");
    const box = await create.boundingBox();
    if (!box) throw new Error(`New has no box on ${address}.`);
    first ??= box;
    expect(box, `New on ${address}`).toEqual(first);
  }
  // A folder that does not exist has nothing to create in either: New creates in the Files home.
  await page.goto(`/browse/missing-${randomUUID()}`);
  await expect(
    page.getByRole("heading", { name: "Folder not found", exact: true }),
  ).toBeVisible();
  await expect(create).toBeEnabled();
  expect(await create.boundingBox()).toEqual(first);
});

test("New folder off a folder creates it in Files and goes there to show it", async ({
  page,
  context,
  isMobile,
}) => {
  const name = `from-shared-${randomUUID().slice(0, 8)}`;
  await page.goto("/shared");
  await expect(
    page.getByRole("heading", { name: "Shared", exact: true }),
  ).toBeVisible();
  await watchArrivals(page);
  await whenCanCreate(page);
  await newButton(page, isMobile).click();
  await newItem(page, isMobile, "New folder").click();
  const dialog = page.getByRole("dialog", { name: "New folder", exact: true });
  await dialog.getByRole("textbox").fill(name);
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(dialog).toBeHidden();
  // The administrator's Files is the drive root.
  await expect(page).toHaveURL(`${origin}/`);
  await expect(
    page.locator(`[data-entry-name="${name}"]`).filter({ visible: true }),
  ).toBeVisible();
  expect(await arrived(page)).toContain(name);
  expect(await names(context, "")).toContain(name);
});

test("Upload file off a folder uploads to Files with its progress, and goes there to show it", async ({
  page,
  context,
  isMobile,
}) => {
  const name = `from-recent-${randomUUID().slice(0, 8)}.txt`;
  await page.goto("/recent");
  await expect(
    page.getByRole("heading", { name: "Recent", exact: true }),
  ).toBeVisible();
  await watchArrivals(page);
  // The upload waits until its progress has been seen.
  const released = Promise.withResolvers<void>();
  await page.route(
    (url) => url.pathname.startsWith("/api/upload"),
    async (route) => {
      await released.promise;
      await route.fallback();
    },
  );
  await whenCanCreate(page);
  const chooser = page.waitForEvent("filechooser");
  await newButton(page, isMobile).click();
  await newItem(page, isMobile, "Upload file").click();
  await (
    await chooser
  ).setFiles({
    name,
    mimeType: "text/plain",
    buffer: Buffer.from("uploaded from Recent"),
  });
  await expect(page).toHaveURL(`${origin}/`);
  await expect(
    page.getByRole("progressbar", { name: "Upload progress", exact: true }),
  ).toBeVisible();
  released.resolve();
  await expect(
    page.locator(`[data-entry-name="${name}"]`).filter({ visible: true }),
  ).toBeVisible();
  expect(await arrived(page)).toContain(name);
  expect(await names(context, "")).toContain(name);
});

test("a member's New off a folder creates in their home, where their Files opens", async ({
  page,
  context,
  browser,
  isMobile,
}) => {
  const { member, memberContext, home } = await asMember(
    browser,
    context,
    page,
    isMobile,
    [],
  );
  try {
    const name = `from-starred-${randomUUID().slice(0, 8)}`;
    await member.goto("/starred");
    await expect(
      member.getByRole("heading", { name: "Starred", exact: true }),
    ).toBeVisible();
    await watchArrivals(member);
    await whenCanCreate(member);
    await newButton(member, isMobile).click();
    await newItem(member, isMobile, "New folder").click();
    const dialog = member.getByRole("dialog", {
      name: "New folder",
      exact: true,
    });
    await dialog.getByRole("textbox").fill(name);
    await dialog.getByRole("button", { name: "Create", exact: true }).click();
    await expect(member).toHaveURL(
      `${origin}/browse/${home.split("/").map(encodeURIComponent).join("/")}`,
    );
    await expect(
      member.locator(`[data-entry-name="${name}"]`).filter({ visible: true }),
    ).toBeVisible();
    expect(await arrived(member)).toContain(name);
    expect(await names(memberContext, home)).toContain(name);
  } finally {
    await memberContext.close();
  }
});

/**
 * Signs in a new account with no home folder that may only view `folder`: one created while the
 * folder holding every home was shared gets none. The sharing ends before this returns.
 */
async function viewOnlyAccount(
  page: Page,
  context: BrowserContext,
  isMobile: boolean,
  folder: string,
) {
  const rpc = await client(context);
  const createUser = async (name: string) => {
    const email = `${name.toLowerCase().replace(" ", "-")}-${randomUUID().slice(0, 8)}@nimbus.test`;
    const created = await context.request.post("/api/auth/admin/create-user", {
      headers: { Origin: origin },
      data: { name, email, password, role: "user" },
    });
    expect(created.ok()).toBe(true);
    const person = (await rpc.access.people.query({ path: "" })).find(
      (entry) => entry.email === email,
    );
    if (!person) throw new Error(`${email} is not listed.`);
    return { email, id: person.id };
  };
  const holder = await createUser("Robin Holder");
  await rpc.access.setHomeContainerSharing.mutate({ allowed: true });
  let viewer: { email: string; id: string };
  try {
    await rpc.access.grant.mutate({
      path: "users",
      subject: { type: "user", id: holder.id },
      permission: "read",
      acknowledgeAllHomeFolders: true,
    });
    viewer = await createUser("Quinn Viewer");
  } finally {
    const review = await rpc.access.homeContainerSharing.query();
    for (const grant of review.records.grants)
      await rpc.access.removeHomeContainerSharing.mutate({
        kind: "grant",
        id: grant.id,
      });
    await rpc.access.setHomeContainerSharing.mutate({ allowed: false });
  }
  await rpc.access.grant.mutate({
    path: folder,
    subject: { type: "user", id: viewer.id },
    permission: "read",
  });
  const viewerContext = await page
    .context()
    .browser()
    ?.newContext({
      storageState: { cookies: [], origins: [] },
      viewport: page.viewportSize(),
      isMobile,
      hasTouch: isMobile,
    });
  if (!viewerContext) throw new Error("The browser is not available.");
  const viewerPage = await viewerContext.newPage();
  await login(viewerPage, viewer.email);
  expect((await (await client(viewerContext)).access.me.query()).home).toBe(
    null,
  );
  return { viewerPage, viewerContext };
}

test("with nowhere to create, New stays, disabled, and says why", async ({
  page,
  context,
  isMobile,
}) => {
  const folder = `view-only-${randomUUID().slice(0, 8)}`;
  await (await client(context)).files.createFolder.mutate({ name: folder });
  const { viewerPage, viewerContext } = await viewOnlyAccount(
    page,
    context,
    isMobile,
    folder,
  );
  const reasons = {
    account:
      "Your account can view files, but has no folder to add them to. Ask an administrator for one.",
    folder: "You can view this folder, but not add to it.",
  };
  try {
    for (const [address, reason] of [
      ["/shared", reasons.account],
      ["/recent", reasons.account],
      [`/browse/${folder}`, reasons.folder],
    ] as const) {
      await viewerPage.goto(address);
      const create = newButton(viewerPage, isMobile);
      await expect(create).toBeVisible();
      await expect(create).toHaveAttribute("aria-disabled", "true");
      if (!isMobile) {
        // A pointer's hover shows the reason; it is the button's description too.
        await expect(create).toHaveAccessibleDescription(reason);
        await create.hover();
        // Fluid Functionalism's tooltip, positioned beside its button.
        await expect(
          viewerPage.locator('[role="presentation"][data-side]', {
            hasText: reason,
          }),
        ).toBeVisible();
        await viewerPage.mouse.move(0, 0);
      }
      // A press, as a finger's, says why too, and opens nothing. Playwright waits for a button
      // marked disabled to turn enabled before it clicks; a person's press reaches it at once.
      await create.click({ force: true });
      await expect(
        viewerPage
          .getByRole("region", { name: /Notifications/ })
          .getByText(reason),
      ).toBeVisible();
      await expect(newItem(viewerPage, isMobile, "New folder")).toHaveCount(0);
    }
  } finally {
    await viewerContext.close();
  }
});
