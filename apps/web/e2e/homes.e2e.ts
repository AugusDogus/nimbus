import { expect } from "@playwright/test";
import { client, navigate, test } from "./helpers";

test("My files opens the account's own home folder, which cannot be moved or deleted", async ({
  page,
  context,
  isMobile,
}) => {
  await page.goto("/");
  await navigate(page, "My files", isMobile);
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
  for (const label of ["Rename", "Move", "Move to trash"])
    expect(await menuItems("users")).not.toContain(label);
  await page.goto("/browse/users");
  await expect(entry("admin")).toBeVisible();
  for (const label of ["Rename", "Move", "Move to trash"])
    expect(await menuItems("admin")).not.toContain(label);
  expect(await entry("admin").getAttribute("draggable")).not.toBe("true");
});
