import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import { expect, test as base, type BrowserContext, type Download, type Page } from "@playwright/test";
import type { AppRouter } from "@nimbus/api/routers";

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
  browserErrors: [async ({ page }, use) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await use();
    expect(errors, "Browser runtime errors").toEqual([]);
  }, { auto: true }],
});

export async function login(page: Page, email = adminEmail) {
  await page.goto("/login");
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("button", { name: "Account menu" })).toBeVisible();
}

export async function client(context: BrowserContext) {
  const cookies = await context.cookies("http://localhost:3100");
  return createTRPCClient<AppRouter>({ links: [httpBatchLink({
    url: "http://localhost:3100/api/trpc",
    headers: { cookie: cookies.map(({ name, value }) => `${name}=${value}`).join("; ") },
  })] });
}

export async function action(page: Page, name: string, label: string, mobile: boolean) {
  await page.getByRole("button", { name: `Actions for ${name}`, exact: true }).click();
  await page.getByRole(mobile ? "button" : "menuitem", { name: label, exact: true }).click();
}

export async function navigate(page: Page, name: string, mobile: boolean) {
  if (mobile) await page.getByRole("button", { name: "Toggle Sidebar", exact: true }).click();
  await page.getByRole("navigation", { name: "Files", exact: true }).getByRole("link", { name, exact: true }).click();
  if (mobile) {
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Sidebar", exact: true })).toBeHidden();
  }
}

export async function createFolder(page: Page, name: string, mobile: boolean) {
  await page.getByRole("button", { name: mobile ? "New file or folder" : "New", exact: true }).click();
  await page.getByRole(mobile ? "button" : "menuitem", { name: "New folder", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New folder", exact: true });
  await dialog.getByRole("textbox").fill(name);
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("link", { name, exact: true })).toBeVisible();
}

export async function upload(page: Page, name: string, body: string) {
  await page.locator('input[type="file"]').setInputFiles({ name, mimeType: "text/plain", buffer: Buffer.from(body) });
  await expect(page.locator(`[data-entry-name="${name}"]`)).toBeVisible();
}

export async function downloadText(download: Download) {
  const file = await download.path();
  if (file === null) throw new Error("The browser did not save the requested download.");
  return readFile(file, "utf8");
}
