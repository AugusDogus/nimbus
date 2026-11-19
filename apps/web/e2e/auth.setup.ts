import { expect } from "@playwright/test";
import { test } from "./helpers";
import { adminEmail, client, login, password } from "./helpers";

test("first account becomes administrator and can sign out and back in", async ({
  page,
  context,
}) => {
  await page.goto("/signup");
  // Setup exists only before the first account, so it offers no sign-in.
  await expect(page.getByText("Set up Nimbus", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Sign in" })).toHaveCount(0);
  await page.getByLabel("Full Name").fill("Nimbus Administrator");
  await page.getByLabel("Email", { exact: true }).fill(adminEmail);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByLabel("Confirm Password").fill(password);
  await page
    .getByRole("button", { name: "Create account", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Account menu", exact: true }),
  ).toBeVisible();
  expect((await (await client(context)).access.me.query()).isAdmin).toBe(true);
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("menuitem", { name: "Sign out", exact: true }).click();
  await expect(page).toHaveURL(/\/login$/);
  await login(page);
  await context.storageState({ path: "test-results/.auth/admin.json" });
});
