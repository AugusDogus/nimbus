import { createHmac, randomUUID } from "node:crypto";
import { expect, type Browser, type Page } from "@playwright/test";
import { z } from "zod";
import { client, login, origin, password, test } from "./helpers";

/** RFC 6238 code for a base32 secret, so the test can act as an authenticator app. */
function totp(secret: string, at = Date.now()) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const character of secret.replace(/=+$/, "").toUpperCase())
    bits += alphabet.indexOf(character).toString(2).padStart(5, "0");
  const key = Buffer.from((bits.match(/.{8}/g) ?? []).map((byte) => Number.parseInt(byte, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const digest = createHmac("sha1", key).update(counter).digest();
  const offset = (digest[digest.length - 1] ?? 0) & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

async function createMember(page: Page) {
  const email = `security-${randomUUID()}@nimbus.test`;
  const created = await page.context().request.post("/api/auth/admin/create-user", {
    headers: { Origin: origin },
    data: { name: "Sam Rivera", email, password, role: "user" },
  });
  expect(created.ok()).toBe(true);
  const body = z.object({ user: z.object({ id: z.string() }) }).safeParse(await created.json());
  if (!body.success) throw new Error("The created account did not include an ID.");
  return { email, id: body.data.user.id };
}

async function memberPage(browser: Browser, page: Page) {
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] }, viewport: page.viewportSize() });
  return { context, page: await context.newPage() };
}

test("two-factor authentication guards password sign-in and recovers with a code", async ({ browser, page }) => {
  const { email } = await createMember(page);
  const member = await memberPage(browser, page);
  try {
    await login(member.page, email);
    await member.page.goto("/settings/account");
    const section = member.page.getByRole("region", { name: "Two-factor authentication", exact: true });
    await section.getByRole("button", { name: "Set up", exact: true }).click();
    await member.page.getByRole("dialog").getByLabel("Password", { exact: true }).fill(password);
    await member.page.getByRole("dialog").getByRole("button", { name: "Continue", exact: true }).click();
    await expect(member.page.getByRole("img", { name: "QR code for your authenticator app" })).toBeVisible();
    const secret = await member.page.getByRole("textbox", { name: "Setup key", exact: true }).inputValue();
    await member.page.getByLabel("Code from the app").fill("000000");
    await member.page.getByRole("button", { name: "Turn on", exact: true }).click();
    await expect(member.page.getByRole("alert")).toContainText("That code did not match");
    await member.page.getByLabel("Code from the app").fill(totp(secret));
    await member.page.getByRole("button", { name: "Turn on", exact: true }).click();
    const codes = member.page.getByRole("list", { name: "Recovery codes" }).getByRole("listitem");
    await expect(codes).toHaveCount(10);
    const recovery = (await codes.first().textContent()) ?? "";
    await member.page.getByRole("button", { name: "I’ve saved them" }).click();
    await expect(section).toContainText("On");

    await member.context.clearCookies();
    await member.page.goto("/login");
    await member.page.getByLabel("Email", { exact: true }).fill(email);
    await member.page.getByLabel("Password", { exact: true }).fill(password);
    await member.page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(member.page.getByRole("heading", { name: "Enter your code" })).toBeVisible();
    await member.page.getByRole("button", { name: "Use a recovery code instead" }).click();
    await member.page.getByLabel("Recovery code").fill(recovery);
    await member.page.getByRole("button", { name: "Verify", exact: true }).click();
    await expect(member.page.getByRole("button", { name: "Account menu" })).toBeVisible();

    // A recovery code works once.
    await member.context.clearCookies();
    const again = await member.context.request.post("/api/auth/sign-in/email", { headers: { Origin: origin }, data: { email, password } });
    expect(await again.json()).toMatchObject({ twoFactorRedirect: true });
    const reused = await member.context.request.post("/api/auth/two-factor/verify-backup-code", { headers: { Origin: origin }, data: { code: recovery } });
    expect(reused.ok()).toBe(false);
  } finally {
    await member.context.close();
  }
});

test("sessions can be reviewed and signed out, and administrators can reset sign-in methods", async ({ browser, page, isMobile }) => {
  const { email } = await createMember(page);
  const first = await memberPage(browser, page);
  const second = await memberPage(browser, page);
  try {
    await login(first.page, email);
    await login(second.page, email);
    await first.page.goto("/settings/account");
    const sessions = first.page.getByRole("list", { name: "Sessions", exact: true }).getByRole("listitem");
    await expect(sessions).toHaveCount(2);
    await expect(sessions.filter({ hasText: "This browser" })).toHaveCount(1);
    expect(await first.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await first.page.getByRole("button", { name: "Sign out other sessions", exact: true }).click();
    await first.page.getByRole("alertdialog").getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(sessions).toHaveCount(1);
    await second.page.reload();
    await expect(second.page).toHaveURL(/\/login$/);

    await page.goto("/settings/admin");
    await page.getByRole("button", { name: `Actions for ${email}`, exact: true }).click();
    await page.getByRole(isMobile ? "menuitem" : "menuitem", { name: "Reset sign-in methods", exact: true }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Confirm", exact: true }).click();
    await expect(page.getByRole("alertdialog")).toBeHidden();
    await first.page.reload();
    await expect(first.page).toHaveURL(/\/login$/);

    await page.goto("/settings/admin/audit");
    const events = page.getByRole("list", { name: "Audit events" });
    // Audit events are written in the background a moment after the action.
    await expect(async () => {
      await page.reload();
      await expect(events).toContainText("Reset sign-in methods", { timeout: 1_000 });
    }).toPass();
    await expect(events).toContainText("Signed out other sessions");
    await page.getByRole("combobox", { name: "Event" }).click();
    await page.getByRole("option", { name: "Reset sign-in methods", exact: true }).click();
    await expect(page).toHaveURL(/action=account\.second_factors_reset/);
    await expect(events.getByRole("listitem")).not.toContainText(["Signed out other sessions"]);
  } finally {
    await first.context.close();
    await second.context.close();
  }
});

test("passkeys sign in without a password", async ({ browser, page, browserName }) => {
  test.skip(browserName !== "chromium", "Virtual authenticators need the Chrome DevTools Protocol.");
  const { email } = await createMember(page);
  const member = await memberPage(browser, page);
  const cdp = await member.context.newCDPSession(member.page);
  try {
    await cdp.send("WebAuthn.enable");
    const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
      options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
    });
    await login(member.page, email);
    await member.page.goto("/settings/account");
    const section = member.page.getByRole("region", { name: "Passkeys", exact: true });
    await section.getByRole("button", { name: "Add passkey", exact: true }).click();
    await member.page.getByLabel("Passkey name").fill("Test authenticator");
    await member.page.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(section.getByRole("list", { name: "Passkeys" })).toContainText("Test authenticator");

    await member.context.clearCookies();
    // Hold user presence so the email field's passkey autofill request stays pending,
    // then answer the explicit button's request; the button aborts the autofill request.
    await cdp.send("WebAuthn.setAutomaticPresenceSimulation", { authenticatorId, enabled: false });
    await member.page.goto("/login");
    await member.page.getByRole("button", { name: "Sign in with a passkey", exact: true }).click();
    await cdp.send("WebAuthn.setAutomaticPresenceSimulation", { authenticatorId, enabled: true });
    await expect(member.page.getByRole("button", { name: "Account menu" })).toBeVisible();
    // A pending autofill request keeps the virtual authenticator busy; remove it before closing.
    await cdp.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId });
  } finally {
    await cdp.send("WebAuthn.disable").catch(() => undefined);
    await cdp.detach().catch(() => undefined);
    await member.context.close();
  }
});

test("repeated wrong passwords are throttled", async ({ browser, page }) => {
  const { email } = await createMember(page);
  const member = await memberPage(browser, page);
  try {
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 11; attempt++)
      statuses.push((await member.context.request.post("/api/auth/sign-in/email", { headers: { Origin: origin }, data: { email, password: "wrong-password-1" } })).status());
    expect(statuses.slice(0, 10).every((status) => status === 401)).toBe(true);
    expect(statuses[10]).toBe(429);
  } finally {
    await member.context.close();
  }
});

test("WebDAV and public link passwords throttle repeated wrong credentials", async ({ page, request }) => {
  const wrong = { Authorization: `Basic ${Buffer.from(`nobody@nimbus.test:${randomUUID()}`).toString("base64")}` };
  expect((await request.fetch("/dav/", { method: "PROPFIND", headers: { Depth: "0" } })).status()).toBe(401);
  const dav: number[] = [];
  for (let attempt = 0; attempt < 21; attempt++)
    dav.push((await request.fetch("/dav/", { method: "PROPFIND", headers: { ...wrong, Depth: "0" } })).status());
  expect(dav.slice(0, 20).every((status) => status === 401)).toBe(true);
  expect(dav[20]).toBe(429);

  const caller = page.context().request;
  const created = await client(page.context());
  const share = await created.shares.create.mutate({ path: "alpha.txt", expiresAt: null, password: "correct-horse-1" });
  const attempts: number[] = [];
  for (let attempt = 0; attempt < 11; attempt++)
    attempts.push((await caller.post(`/api/share/${share.token}`, { data: { password: "wrong-password" } })).status());
  expect(attempts.slice(0, 10).every((status) => status === 401)).toBe(true);
  expect(attempts[10]).toBe(429);
  await page.goto("/settings/admin/audit?action=share.password_failed");
  await expect(async () => {
    await page.reload();
    await expect(page.getByRole("list", { name: "Audit events" }).getByRole("listitem").first()).toContainText("Wrong public link password · alpha.txt", { timeout: 1_000 });
  }).toPass();
});
