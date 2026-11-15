import { randomUUID } from "node:crypto";
import { expect } from "@playwright/test";
import { login, origin, password, test } from "./helpers";

test("account shows identity and validates password changes", async ({
  context,
  browser,
  page,
}, testInfo) => {
  const email = `account-${randomUUID()}@nimbus.test`;
  const name = "Alex Morgan";
  const newPassword = `${password}-updated`;
  const created = await context.request.post("/api/auth/admin/create-user", {
    headers: { Origin: origin },
    data: { name, email, password, role: "user" },
  });
  expect(created.ok()).toBe(true);
  const memberContext = await browser.newContext({
    storageState: { cookies: [], origins: [] },
    viewport: page.viewportSize(),
  });
  try {
    const member = await memberContext.newPage();
    await login(member, email);
    await member.goto("/settings/account");
    const profile = member.getByRole("region", {
      name: "Profile",
      exact: true,
    });
    const security = member.getByRole("region", {
      name: "Password",
      exact: true,
    });
    await expect(profile).toContainText(name);
    await expect(profile).toContainText(email);
    await member.getByLabel("Current password", { exact: true }).fill(password);
    await member.getByLabel("New password", { exact: true }).fill(newPassword);
    await member
      .getByLabel("Confirm new password", { exact: true })
      .fill(`${newPassword}-mismatch`);
    await member
      .getByRole("button", { name: "Change password", exact: true })
      .click();
    await expect(security.getByRole("alert")).toHaveText(
      "The new passwords do not match.",
    );
    await member
      .getByLabel("Current password", { exact: true })
      .fill("wrong-current-password");
    await member
      .getByLabel("Confirm new password", { exact: true })
      .fill(newPassword);
    await member
      .getByRole("button", { name: "Change password", exact: true })
      .click();
    await expect(security.getByRole("alert")).not.toHaveText(
      "The new passwords do not match.",
    );
    await expect(
      member.getByRole("button", { name: "Change password", exact: true }),
    ).toBeEnabled();
    await member.getByLabel("Current password", { exact: true }).fill(password);
    await member
      .getByRole("button", { name: "Change password", exact: true })
      .click();
    await expect(security.getByRole("status")).toContainText(
      "Password changed.",
    );
    await expect(
      member.getByLabel("Current password", { exact: true }),
    ).toHaveValue("");
    expect(
      await member.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await member.screenshot({
      path: testInfo.outputPath("account.png"),
      animations: "disabled",
    });
    const oldLogin = await memberContext.request.post(
      "/api/auth/sign-in/email",
      {
        headers: { Origin: origin },
        data: { email, password },
      },
    );
    expect(oldLogin.ok()).toBe(false);
    const newLogin = await memberContext.request.post(
      "/api/auth/sign-in/email",
      {
        headers: { Origin: origin },
        data: { email, password: newPassword },
      },
    );
    expect(newLogin.ok()).toBe(true);
  } finally {
    await memberContext.close();
  }
});
