import { randomUUID } from "node:crypto";
import { expect } from "@playwright/test";
import {
  action,
  adminEmail,
  createFolder,
  navigate,
  origin,
  password,
  test,
} from "./helpers";

test("an administrator signs in as a member, acts as them, and returns to their own account", async ({
  page,
  isMobile,
}) => {
  const email = `impersonated-${randomUUID().slice(0, 8)}@nimbus.test`;
  const created = await page
    .context()
    .request.post("/api/auth/admin/create-user", {
      headers: { Origin: origin },
      data: { name: "Robin Park", email, password, role: "user" },
    });
  expect(created.ok()).toBe(true);

  await page.goto("/settings/admin");
  await page
    .getByRole("button", { name: `Actions for ${email}`, exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Sign in as user", exact: true })
    .click();
  const confirmation = page.getByRole("alertdialog", {
    name: `Sign in as ${email}?`,
  });
  await expect(confirmation).toContainText("audit log");
  await confirmation
    .getByRole("button", { name: "Sign in as user", exact: true })
    .click();

  const banner = page.getByRole("region", { name: "Impersonation" });
  await expect(banner).toContainText(`You are signed in as ${email}`);
  // As the member: create a folder in their home and move it to trash.
  await navigate(page, "My files", isMobile);
  const folder = `impersonated-${randomUUID().slice(0, 8)}`;
  await createFolder(page, folder, isMobile);
  await action(page, folder, "Move to trash", isMobile);
  await page
    .getByRole("alertdialog", { name: "Move to trash?" })
    .getByRole("button", { name: "Move to trash", exact: true })
    .click();
  await expect(
    page.getByRole("link", { name: folder, exact: true }),
  ).toBeHidden();
  // The banner stays on every signed-in page.
  await page.goto("/settings/account");
  await expect(banner).toBeVisible();

  await banner
    .getByRole("button", { name: "Stop impersonating", exact: true })
    .click();
  await expect(page).toHaveURL(`${origin}/settings/admin`);
  await expect(banner).toBeHidden();
  await expect(
    page.getByRole("button", { name: `Actions for ${email}`, exact: true }),
  ).toBeVisible();

  await page.goto("/settings/admin/audit");
  const events = page.getByRole("list", { name: "Audit events" });
  // Audit events are written in the background a moment after the action.
  await expect(async () => {
    await page.reload();
    await expect(events).toContainText("Stopped signing in as this account", {
      timeout: 1_000,
    });
  }).toPass();
  const trashed = events
    .getByRole("listitem")
    .filter({ hasText: "Moved to trash" })
    .filter({ hasText: folder });
  await expect(trashed).toContainText(
    `Done by ${adminEmail} while signed in as ${email}`,
  );
  await expect(
    events
      .getByRole("listitem")
      .filter({ hasText: "Started signing in as this account" })
      .filter({ hasText: email }),
  ).toContainText(adminEmail);
});
