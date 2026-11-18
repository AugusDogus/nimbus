import { randomUUID } from "node:crypto";
import { expect } from "@playwright/test";
import { action, client, login, origin, password, test } from "./helpers";

/**
 * Sharing the folder that holds every home folder (`users`), or My Drive above it, is off by
 * default for everyone; an administrator can allow it, and then each share needs an extra
 * confirmation. The setting is global, so every test turns it off again. Pages start signed in
 * as the administrator.
 */
test.describe("sharing the home folders container", () => {
  test.afterEach(async ({ context }) => {
    const rpc = await client(context);
    await rpc.access.setHomeContainerSharing.mutate({ allowed: false });
    const review = await rpc.access.homeContainerSharing.query();
    for (const grant of review.records.grants)
      await rpc.access.removeHomeContainerSharing.mutate({
        kind: "grant",
        id: grant.id,
      });
    for (const link of review.records.links)
      await rpc.access.removeHomeContainerSharing.mutate({
        kind: "link",
        id: link.id,
      });
    for (const request of review.records.fileRequests)
      await rpc.access.removeHomeContainerSharing.mutate({
        kind: "uploadLink",
        id: request.id,
      });
  });

  test("with the setting off, an administrator is told why My Drive cannot be shared", async ({
    page,
    context,
  }) => {
    await page.goto("/settings/admin");
    await page
      .getByRole("button", { name: "Manage drive access", exact: true })
      .click();
    const dialog = page.getByRole("dialog", { name: "Share My Drive" });
    await expect(
      dialog.getByText("Sharing this folder is turned off").first(),
    ).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: "Grant access", exact: true }),
    ).toBeDisabled();
    await expect(
      dialog.getByRole("button", { name: "Create link", exact: true }),
    ).toBeDisabled();
    // The server refuses too, whoever asks and however.
    const rpc = await client(context);
    await expect(
      rpc.shares.create.mutate({ path: "users", expiresAt: null }),
    ).rejects.toThrow("Allow sharing the home folders container");
  });

  test("a member who manages the container's sharing is refused once the setting is off, and the administrator reviews it", async ({
    page,
    context,
    browser,
    isMobile,
  }) => {
    const suffix = randomUUID().slice(0, 8);
    const email = `container-${suffix}@nimbus.test`;
    const created = await context.request.post("/api/auth/admin/create-user", {
      headers: { Origin: origin },
      data: { name: "Kim Container", email, password, role: "user" },
    });
    expect(created.ok()).toBe(true);
    const rpc = await client(context);
    const person = (await rpc.access.people.query({ path: "" })).find(
      (entry) => entry.email === email,
    );
    if (!person) throw new Error("The new member is not listed.");
    // Allowed and acknowledged, then turned off: the grant stays and keeps working.
    await rpc.access.setHomeContainerSharing.mutate({ allowed: true });
    await rpc.access.grant.mutate({
      path: "users",
      subject: { type: "user", id: person.id },
      permission: "admin",
      acknowledgeAllHomeFolders: true,
    });
    await rpc.access.setHomeContainerSharing.mutate({ allowed: false });
    const member = await browser.newContext({
      storageState: { cookies: [], origins: [] },
      viewport: page.viewportSize(),
    });
    try {
      const sharer = await member.newPage();
      await login(sharer, email);
      await sharer.goto("/shared");
      await action(sharer, "users", "Share", isMobile);
      const dialog = sharer.getByRole("dialog", { name: "Share users" });
      await expect(
        dialog.getByText(/users holds every user's home folder/).first(),
      ).toBeVisible();
      await expect(
        dialog.getByRole("button", { name: "Create link", exact: true }),
      ).toBeDisabled();
      await expect(
        (await client(member)).shares.create.mutate({
          path: "users",
          expiresAt: null,
        }),
      ).rejects.toThrow("Nothing was changed");
    } finally {
      await member.close();
    }
    await page.goto("/settings/admin");
    const list = page.getByRole("list", {
      name: "Sharing that reaches every home folder",
    });
    await expect(
      list.getByText(`${email} has admin access to "users"`),
    ).toBeVisible();
    await list
      .getByRole("button", {
        name: `Remove: ${email} has admin access to "users"`,
      })
      .click();
    await expect(
      page.getByText("Removed. Everything else is unchanged."),
    ).toBeVisible();
    await expect(list).toBeHidden();
  });

  test("an administrator turns sharing on after a confirmation, and each share needs an extra one", async ({
    page,
  }) => {
    await page.goto("/settings/admin");
    const toggle = page.getByRole("switch", {
      name: "Allow sharing the home folders container",
    });
    await expect(toggle).not.toBeChecked();
    // Keyboard only: the switch and the confirmation checkbox take Space.
    await toggle.focus();
    await page.keyboard.press("Space");
    const confirmation = page.getByRole("alertdialog", {
      name: "Allow sharing the home folders container?",
    });
    await expect(confirmation).toContainText("new accounts get no home folder");
    await confirmation
      .getByRole("button", { name: "Allow sharing", exact: true })
      .click();
    await expect(toggle).toBeChecked();

    await page
      .getByRole("button", { name: "Manage drive access", exact: true })
      .click();
    const dialog = page.getByRole("dialog", { name: "Share My Drive" });
    const linkWarning = dialog.locator("#share-link-homes");
    await expect(linkWarning).toContainText(
      "This gives access to every home folder",
    );
    await expect(linkWarning).toContainText(/all \d+ home folders?/);
    const create = dialog.getByRole("button", {
      name: "Create link",
      exact: true,
    });
    await expect(create).toBeDisabled();
    await linkWarning
      .getByRole("checkbox", { name: /I understand this exposes all \d+/ })
      .focus();
    await page.keyboard.press("Space");
    await expect(create).toBeEnabled();
    await create.click();
    await expect(
      dialog.getByRole("textbox", { name: "Share link" }),
    ).toHaveValue(/\/s\//);

    // The upload link flow asks for its own confirmation.
    await dialog
      .getByRole("button", { name: "Request files", exact: true })
      .click();
    const request = page.getByRole("dialog", {
      name: "Request files for My Drive",
    });
    const upload = request.getByRole("button", {
      name: "Create upload link",
      exact: true,
    });
    await expect(request.locator("#file-request-homes")).toContainText(
      "add files to the folder that holds all",
    );
    await expect(upload).toBeDisabled();
    await request
      .getByRole("checkbox", { name: /I understand this exposes/ })
      .click();
    await upload.click();
    await expect(
      request.getByRole("textbox", { name: "Upload link" }),
    ).toHaveValue(/\/r\//);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");

    // Turning it off keeps both, lists them, and says so.
    await page.goto("/settings/admin");
    await toggle.click();
    await expect(
      page.getByText(
        "Turned off. The sharing listed below keeps working until you remove it.",
      ),
    ).toBeVisible();
    await expect(toggle).not.toBeChecked();
    const list = page.getByRole("list", {
      name: "Sharing that reaches every home folder",
    });
    await expect(list.getByText(/^Public link to My Drive/)).toBeVisible();
    await expect(list.getByText(/^Upload link for My Drive/)).toBeVisible();
    await page.getByRole("button", { name: "Remove all", exact: true }).click();
    const removeAll = page.getByRole("alertdialog");
    await removeAll
      .getByRole("button", { name: "Remove all", exact: true })
      .click();
    // The open dialog hides the page from assistive technology, so wait for it to close first.
    await expect(removeAll).toBeHidden();
    await expect(list).toBeHidden();
    await expect(
      page.getByText("Sharing that reaches every home folder", { exact: true }),
    ).toBeHidden();
  });

  test("the setting and the warning fit 320 px wide and 200% zoom without scrolling sideways", async ({
    page,
    context,
  }) => {
    await (
      await client(context)
    ).access.setHomeContainerSharing.mutate({
      allowed: true,
    });
    // 640 CSS pixels is a 1280 pixel window at 200% zoom.
    for (const width of [320, 640]) {
      await page.setViewportSize({ width, height: 720 });
      await page.goto("/settings/admin");
      await expect(
        page.getByRole("switch", {
          name: "Allow sharing the home folders container",
        }),
      ).toBeChecked();
      const overflow = () =>
        page.evaluate(
          () => document.documentElement.scrollWidth - window.innerWidth,
        );
      expect(await overflow()).toBeLessThanOrEqual(0);
      await page
        .getByRole("button", { name: "Manage drive access", exact: true })
        .click();
      const warning = page
        .getByRole("dialog", { name: "Share My Drive" })
        .locator("#share-grant-homes");
      await expect(warning).toBeVisible();
      const box = await warning.boundingBox();
      expect(box && box.x >= 0 && box.x + box.width <= width).toBe(true);
      expect(await overflow()).toBeLessThanOrEqual(0);
      await page.keyboard.press("Escape");
    }
  });
});
