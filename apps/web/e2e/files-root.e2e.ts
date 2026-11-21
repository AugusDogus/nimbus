import { randomUUID } from "node:crypto";
import { expect, type Page } from "@playwright/test";
import {
  adminEmail,
  asMember,
  client,
  login,
  navigate,
  password,
  test,
} from "./helpers";

const homeAddress = (home: string) => `/browse/${home}`;

test("a member who reaches only their home starts there, and Files opens it", async ({
  browser,
  context,
  page,
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
    await expect(member).toHaveURL(homeAddress(home));
    await member.goto("/");
    await expect(member).toHaveURL(homeAddress(home));
    await member.goto("/home");
    await expect(member).toHaveURL(homeAddress(home));
    // The redirect replaces `/`, so Back and Forward never bounce through it.
    await navigate(member, "Recent", isMobile);
    await expect(member).toHaveURL("/recent");
    await navigate(member, "Files", isMobile);
    await expect(member).toHaveURL(homeAddress(home));
    await member.goBack();
    await expect(member).toHaveURL("/recent");
    await member.goForward();
    await expect(member).toHaveURL(homeAddress(home));
  } finally {
    await memberContext.close();
  }
});

test("a member with something shared outside their home starts in it, while Files opens the root", async ({
  browser,
  context,
  page,
  isMobile,
}) => {
  const top = `shared-${randomUUID()}`;
  const rpc = await client(context);
  await rpc.files.createFolder.mutate({ name: top });
  await rpc.files.createFolder.mutate({ path: top, name: "team" });
  const { member, memberContext, home } = await asMember(
    browser,
    context,
    page,
    isMobile,
    [{ path: `${top}/team`, permission: "read" }],
  );
  try {
    await expect(member).toHaveURL(homeAddress(home));
    await navigate(member, "Files", isMobile);
    await expect(member).toHaveURL("/");
    await expect(
      member.locator(`[data-entry-name="${top}"]`).first(),
    ).toBeVisible();
  } finally {
    await memberContext.close();
  }
});

test("the administrator starts at the drive root, and a link followed through sign-in wins", async ({
  browser,
  context,
  page,
}) => {
  const folder = `deep-${randomUUID()}`;
  await (await client(context)).files.createFolder.mutate({ name: folder });
  const fresh = await browser.newContext({
    storageState: { cookies: [], origins: [] },
    viewport: page.viewportSize(),
  });
  try {
    const admin = await fresh.newPage();
    await login(admin, adminEmail);
    await expect(admin).toHaveURL("/");
    await admin
      .getByRole("button", { name: "Account menu", exact: true })
      .click();
    await admin
      .getByRole("menuitem", { name: "Sign out", exact: true })
      .click();
    await expect(admin).toHaveURL(/\/login$/);
    await admin.goto(`/browse/${folder}`);
    await expect(admin).toHaveURL(/\/login\?callbackURL=/);
    await admin.getByLabel("Email", { exact: true }).fill(adminEmail);
    await admin.getByLabel("Password", { exact: true }).fill(password);
    await admin.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(admin).toHaveURL(`/browse/${folder}`);
  } finally {
    await fresh.close();
  }
});

const breadcrumbRoot = (on: Page) =>
  on.locator('nav[aria-label="breadcrumb"] a[aria-label="Files"]');
const shownName = (on: Page) =>
  on.locator('nav[aria-label="breadcrumb"] [aria-current="page"]');

test("the breadcrumb roots at Files, the home for a member limited to it, linking real folders", async ({
  browser,
  context,
  page,
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
    const name = "Trip 100% #1";
    await (
      await client(memberContext)
    ).files.createFolder.mutate({
      path: home,
      name,
    });
    await expect(member).toHaveURL(homeAddress(home));
    await expect(
      member.getByRole("heading", { name: "Files", exact: true }),
    ).toBeVisible();
    await member.getByRole("link", { name, exact: true }).click();
    await expect(member).toHaveURL(
      `${homeAddress(home)}/${encodeURIComponent(name)}`,
    );
    await expect(shownName(member)).toHaveText(name);
    await expect(breadcrumbRoot(member)).toHaveAttribute(
      "href",
      homeAddress(home),
    );
    await breadcrumbRoot(member).click();
    await expect(member).toHaveURL(homeAddress(home));
  } finally {
    await memberContext.close();
  }
});

test("the breadcrumb shows the real ancestry for the administrator and for a member with a nested grant", async ({
  browser,
  context,
  page,
  isMobile,
}) => {
  const top = `documents-${randomUUID()}`;
  const rpc = await client(context);
  await rpc.files.createFolder.mutate({ name: top });
  await rpc.files.createFolder.mutate({ path: top, name: "team" });
  await rpc.files.createFolder.mutate({ path: `${top}/team`, name: "reports" });
  await page.goto(`/browse/${top}/team/reports`);
  await expect(shownName(page)).toHaveText("reports");
  await expect(breadcrumbRoot(page)).toHaveAttribute("href", "/");
  const { member, memberContext } = await asMember(
    browser,
    context,
    page,
    isMobile,
    [{ path: `${top}/team/reports`, permission: "read" }],
  );
  try {
    await member.goto(`/browse/${top}/team`);
    await expect(shownName(member)).toHaveText("team");
    await expect(breadcrumbRoot(member)).toHaveAttribute("href", "/");
    if (!isMobile)
      await expect(
        member
          .locator('nav[aria-label="breadcrumb"]')
          .getByRole("link", { name: top, exact: true }),
      ).toBeVisible();
  } finally {
    await memberContext.close();
  }
});

test("the server answers the start and home addresses with redirects, signed in or not", async ({
  page,
  browser,
}) => {
  // As a browser loads a page, so the server answers with the page or a redirect.
  const load = (on: { get: typeof page.request.get }, address: string) =>
    on.get(address, {
      headers: { "Sec-Fetch-Dest": "document" },
      maxRedirects: 0,
    });
  const signedIn = await load(page.request, "/start");
  expect(signedIn.status()).toBe(307);
  expect(new URL(signedIn.headers().location ?? "").pathname).toBe("/");
  const home = await load(page.request, "/home");
  expect(home.status()).toBe(307);
  expect(new URL(home.headers().location ?? "").pathname).toBe(
    "/browse/users/admin",
  );
  const visitor = await browser.newContext({
    storageState: { cookies: [], origins: [] },
  });
  try {
    const start = await load(visitor.request, "/start");
    expect(start.status()).toBe(307);
    expect(new URL(start.headers().location ?? "").pathname).toBe("/login");
    const homeOut = await load(visitor.request, "/home");
    expect(homeOut.status()).toBe(307);
    const signIn = new URL(homeOut.headers().location ?? "");
    expect(signIn.pathname).toBe("/login");
    expect(signIn.searchParams.get("callbackURL")).toBe("/home");
  } finally {
    await visitor.close();
  }
});
