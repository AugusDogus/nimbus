import { randomUUID } from "node:crypto";
import { expect } from "@playwright/test";
import { client, origin, password, test } from "./helpers";

test("/home opens the account's own home folder, which cannot be moved or deleted", async ({
  page,
  context,
}) => {
  await page.goto("/home");
  await expect(page).toHaveURL("/browse/users/admin");
  const rpc = await client(context);
  expect((await rpc.access.me.query()).home).toBe("users/admin");
  await expect(
    rpc.files.rename.mutate({ path: "users/admin", newName: "elsewhere" }),
  ).rejects.toMatchObject({ data: { code: "BAD_REQUEST" } });
  await expect(
    rpc.files.delete.mutate({ path: "users" }),
  ).rejects.toMatchObject({ data: { code: "BAD_REQUEST" } });
});

test("menus offer no rename, move or trash on home folders and the folder holding them", async ({
  page,
  isMobile,
}) => {
  const entry = (name: string) =>
    page.locator(`[data-entry-name="${name}"]`).filter({ visible: true });
  const menuItems = async (name: string) => {
    await page
      .getByRole("button", { name: `Actions for ${name}`, exact: true })
      .click();
    const items = page.getByRole(isMobile ? "button" : "menuitem");
    await expect(items.filter({ hasText: "Copy to…" }).first()).toBeVisible();
    const labels = await items.allTextContents();
    await page.keyboard.press("Escape");
    return labels.map((label) => label.trim());
  };
  await page.goto("/");
  await expect(entry("users")).toBeVisible();
  for (const label of ["Rename", "Move to…", "Move to trash"])
    expect(await menuItems("users")).not.toContain(label);
  await page.goto("/browse/users");
  await expect(entry("admin")).toBeVisible();
  for (const label of ["Rename", "Move to…", "Move to trash"])
    expect(await menuItems("admin")).not.toContain(label);
  expect(await entry("admin").getAttribute("draggable")).not.toBe("true");
});

test("the sidebar marks Files on every folder view and each library page on its own", async ({
  page,
  context,
  isMobile,
}) => {
  const other = `sidebar-${randomUUID()}`;
  const created = await context.request.post("/api/auth/admin/create-user", {
    headers: { Origin: origin },
    data: {
      name: "Sidebar Member",
      email: `${other}@nimbus.test`,
      password,
      role: "user",
    },
  });
  expect(created.ok()).toBe(true);
  const nested = `nested-${randomUUID()}`;
  const rpc = await client(context);
  await rpc.files.createFolder.mutate({ path: "users/admin", name: nested });
  const current = async () => {
    if (isMobile)
      await page
        .getByRole("button", { name: "Toggle Sidebar", exact: true })
        .click();
    const sidebar = page.locator('[data-slot="sidebar"]').filter({
      visible: true,
    });
    const marked = sidebar.locator(
      '[data-sidebar="menu-button"][aria-current="page"]',
    );
    const names = await marked.evaluateAll((links) =>
      links.map(
        (link) => link.getAttribute("aria-label") ?? link.textContent?.trim(),
      ),
    );
    if (isMobile) {
      await page.keyboard.press("Escape");
      await expect(
        page.getByRole("dialog", { name: "Sidebar", exact: true }),
      ).toBeHidden();
    }
    return names;
  };

  await page.goto("/home");
  await expect(page).toHaveURL("/browse/users/admin");
  await expect(
    page.locator(`[data-entry-name="${nested}"]`).first(),
  ).toBeVisible();
  expect(await current()).toEqual(["Files"]);
  for (const [address, item] of [
    [`/browse/users/admin/${nested}`, "Files"],
    ["/", "Files"],
    ["/browse/users", "Files"],
    [`/browse/users/${other}`, "Files"],
    ["/shared", "Shared"],
    ["/recent", "Recent"],
    ["/starred", "Starred"],
    ["/trash", "Trash"],
  ]) {
    await page.goto(address);
    await expect(
      page.getByRole("button", { name: "Account menu" }),
    ).toBeVisible();
    await expect.poll(current).toEqual([item]);
  }
  await page.goto("/search?q=readme");
  await expect(
    page.getByRole("button", { name: "Account menu" }),
  ).toBeVisible();
  expect(await current()).toEqual([]);
});
