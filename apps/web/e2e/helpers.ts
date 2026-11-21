import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import {
  expect,
  test as base,
  type Browser,
  type BrowserContext,
  type Download,
  type Page,
} from "@playwright/test";
import type { Permission } from "@nimbus/api/drive-store";
import type { AppRouter } from "@nimbus/api/routers";

export const port = process.env.NIMBUS_E2E_PORT ?? "3100";
export const origin = `http://localhost:${port}`;
export const adminEmail = "admin@nimbus.test";
export const password = "Nimbus-test-password-42";

export const test = base.extend<{ browserErrors: void }>({
  extraHTTPHeaders: async ({ extraHTTPHeaders }, provideHeaders) => {
    // Separate clients keep production login limits isolated between tests.
    const id = randomUUID().replaceAll("-", "");
    await provideHeaders({
      ...extraHTTPHeaders,
      "x-forwarded-for": `fd00:${id.slice(0, 4)}:${id.slice(4, 8)}:${id.slice(8, 12)}::1`,
    });
  },
  browserErrors: [
    async ({ page }, use) => {
      const errors: string[] = [];
      const violations: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      // Every browser test also checks that the Content-Security-Policy blocks nothing.
      page.on("console", (message) => {
        if (message.text().includes("Content Security Policy"))
          violations.push(message.text());
      });
      await use();
      expect(errors, "Browser runtime errors").toEqual([]);
      expect(violations, "Content-Security-Policy violations").toEqual([]);
    },
    { auto: true },
  ],
});

export async function login(page: Page, email = adminEmail) {
  await page.goto("/login");
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Account menu" }),
  ).toBeVisible();
}

export async function client(context: BrowserContext) {
  const cookies = await context.cookies(origin);
  return createTRPCClient<AppRouter>({
    links: [
      httpBatchLink({
        url: `${origin}/api/trpc`,
        headers: {
          cookie: cookies
            .map(({ name, value }) => `${name}=${value}`)
            .join("; "),
        },
      }),
    ],
  });
}

export async function action(
  page: Page,
  name: string,
  label: string,
  mobile: boolean,
) {
  await page
    .getByRole("button", { name: `Actions for ${name}`, exact: true })
    .click();
  await page
    .getByRole(mobile ? "button" : "menuitem", { name: label, exact: true })
    .click();
}

export async function navigate(page: Page, name: string, mobile: boolean) {
  if (mobile)
    await page
      .getByRole("button", { name: "Toggle Sidebar", exact: true })
      .click();
  await page
    .getByRole("navigation", { name: "Files", exact: true })
    .getByRole("link", { name, exact: true })
    .click();
  if (mobile) {
    await page.keyboard.press("Escape");
    await expect(
      page.getByRole("dialog", { name: "Sidebar", exact: true }),
    ).toBeHidden();
  }
}

export async function createFolder(page: Page, name: string, mobile: boolean) {
  await page
    .getByRole("button", {
      name: mobile ? "New file or folder" : "New",
      exact: true,
    })
    .click();
  await page
    .getByRole(mobile ? "button" : "menuitem", {
      name: "New folder",
      exact: true,
    })
    .click();
  const dialog = page.getByRole("dialog", { name: "New folder", exact: true });
  await dialog.getByRole("textbox").fill(name);
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("link", { name, exact: true })).toBeVisible();
}

export async function upload(page: Page, name: string, body: string) {
  await page
    .locator('input[type="file"]')
    .setInputFiles({ name, mimeType: "text/plain", buffer: Buffer.from(body) });
  await expect(
    page.locator(`[data-entry-name="${name}"]`).filter({ visible: true }),
  ).toBeVisible();
}

export async function downloadText(download: Download) {
  const file = await download.path();
  if (file === null)
    throw new Error("The browser did not save the requested download.");
  return readFile(file, "utf8");
}

/**
 * Signs a new member account in on its own page, after the administrator in `context` grants it
 * `grants`. Folders named in them must exist. Close the returned context when done. It signs in
 * without a destination, so it starts where any account does.
 */
export async function asMember(
  browser: Browser,
  context: BrowserContext,
  page: Page,
  isMobile: boolean,
  grants: { path: string; permission: Permission }[],
) {
  const email = `member-${randomUUID()}@nimbus.test`;
  const created = await context.request.post("/api/auth/admin/create-user", {
    headers: { Origin: origin },
    data: { name: "Folder Member", email, password, role: "user" },
  });
  expect(created.ok()).toBe(true);
  const body: unknown = await created.json();
  const id =
    typeof body === "object" &&
    body !== null &&
    "user" in body &&
    typeof body.user === "object" &&
    body.user !== null &&
    "id" in body.user &&
    typeof body.user.id === "string"
      ? body.user.id
      : null;
  if (!id) throw new Error("Creating the member returned no user id.");
  const rpc = await client(context);
  for (const { path, permission } of grants)
    await rpc.access.grant.mutate({
      path,
      subject: { type: "user", id },
      permission,
    });
  const memberContext = await browser.newContext({
    storageState: { cookies: [], origins: [] },
    viewport: page.viewportSize(),
    isMobile,
    hasTouch: isMobile,
  });
  const member = await memberContext.newPage();
  await login(member, email);
  const { home } = await (await client(memberContext)).access.me.query();
  if (home === null) throw new Error(`${email} got no home folder.`);
  return { member, memberContext, email, home };
}
