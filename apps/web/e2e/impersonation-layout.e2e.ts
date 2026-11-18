import { randomUUID } from "node:crypto";
import { expect, type Locator, type Page } from "@playwright/test";
import { createFolder, navigate, origin, password, test } from "./helpers";

/** Signs the page's administrator in as a new member, which shows the impersonation banner. */
async function impersonate(page: Page) {
  const email = `banner-${randomUUID().slice(0, 8)}@nimbus.test`;
  const request = page.context().request;
  const created = await request.post("/api/auth/admin/create-user", {
    headers: { Origin: origin },
    data: { name: "Banner Test", email, password, role: "user" },
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
  const started = await request.post("/api/auth/admin/impersonate-user", {
    headers: { Origin: origin },
    data: { userId: id },
  });
  expect(started.ok()).toBe(true);
}

/** Whether two elements' boxes overlap on screen. */
async function overlap(a: Locator, b: Locator) {
  const [first, second] = await Promise.all([a.boundingBox(), b.boundingBox()]);
  if (!first || !second) return false;
  return (
    first.x < second.x + second.width &&
    second.x < first.x + first.width &&
    first.y < second.y + second.height &&
    second.y < first.y + first.height
  );
}

test("the drawer's last action stays reachable with the impersonation banner on a small phone", async ({
  page,
  isMobile,
}) => {
  test.skip(!isMobile, "Drawers replace menus on touch screens only.");
  // 320 by 568 is the smallest phone in use. At 320 by 480 the banner itself covers half
  // the screen, which is the banner's to fix.
  await page.setViewportSize({ width: 320, height: 568 });
  await impersonate(page);
  await page.goto("/");
  const banner = page.getByRole("region", { name: "Impersonation" });
  await expect(banner).toBeVisible();
  await navigate(page, "My files", true);
  const folder = `banner-${randomUUID().slice(0, 8)}`;
  await createFolder(page, folder, true);
  // The "Created folder" toast times out on its own; it would cover the drawer's foot.
  await expect(
    page.getByRole("region", { name: "Notifications" }).getByText("Created"),
  ).toBeHidden();
  await page
    .getByRole("button", { name: `Actions for ${folder}`, exact: true })
    .click();
  const actions = page.getByRole("dialog", { name: folder, exact: true });
  const trash = actions.getByRole("button", {
    name: "Move to trash",
    exact: true,
  });
  await page.mouse.move(160, 520);
  for (let attempt = 0; attempt < 5; attempt++) {
    const box = await trash.boundingBox();
    if (box && box.y + box.height <= 568) break;
    await page.mouse.wheel(0, 400);
    await page.waitForTimeout(100);
  }
  await trash.click();
  await expect(
    page.getByRole("alertdialog", { name: "Move to trash?" }),
  ).toBeVisible();
});

for (const size of [
  { width: 640, height: 400 },
  { width: 320, height: 640 },
])
  test(`the selection bar and New button clear the impersonation banner at ${size.width}x${size.height}`, async ({
    page,
    isMobile,
  }) => {
    test.skip(
      isMobile,
      "Selecting with modifier keys is a desktop interaction.",
    );
    await page.setViewportSize(size);
    await impersonate(page);
    await page.goto("/");
    const banner = page.getByRole("region", { name: "Impersonation" });
    await expect(banner).toBeVisible();
    await navigate(page, "My files", true);
    const folder = `banner-${randomUUID().slice(0, 8)}`;
    await createFolder(page, folder, true);
    const create = page.getByRole("button", {
      name: "New file or folder",
      exact: true,
    });
    await expect(create).toBeVisible();
    expect(await overlap(create, banner)).toBe(false);
    await page
      .locator(`[data-entry-name="${folder}"]`)
      .filter({ visible: true })
      .click({ modifiers: ["ControlOrMeta"] });
    const bar = page.getByRole("toolbar", { name: "Selected items" });
    await expect(bar).toBeVisible();
    expect(await overlap(bar, banner)).toBe(false);
    await bar.getByRole("button", { name: "Star", exact: true }).click();
    await expect(
      page.getByRole("region", { name: "Notifications" }).getByText("Starred"),
    ).toBeVisible();
  });
