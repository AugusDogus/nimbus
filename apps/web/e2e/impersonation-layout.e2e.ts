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
  // The "Created folder" toast times out on its own; it would cover the drawer's foot. A pointer
  // resting on a toast keeps it open, and the toast now sits where the dialog's button was.
  await page.mouse.move(160, 60);
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

for (const size of [
  { width: 320, height: 480 },
  { width: 320, height: 640 },
  { width: 375, height: 667 },
  // A 1280 by 800 window at 200% zoom.
  { width: 640, height: 400 },
  { width: 1280, height: 800 },
])
  test(`the impersonation banner stays compact, first to focus and below dialogs at ${size.width}x${size.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(size);
    await impersonate(page);
    await page.goto("/");
    const banner = page.getByRole("region", { name: "Impersonation" });
    await expect(banner).toBeVisible();
    const stop = banner.getByRole("button", {
      name: "Stop impersonating",
      exact: true,
    });
    const message = banner.getByRole("status");
    const [bannerBox, messageBox, stopBox] = await Promise.all([
      banner.boundingBox(),
      message.boundingBox(),
      stop.boundingBox(),
    ]);
    if (!bannerBox || !messageBox || !stopBox)
      throw new Error("The banner, its message or its button has no box.");
    // The message reads in lines across the banner, never a word per line beside the button.
    const lineHeight = await message.evaluate((element) =>
      Number.parseFloat(getComputedStyle(element).lineHeight),
    );
    expect(messageBox.height).toBeLessThanOrEqual(4 * lineHeight);
    expect(messageBox.width).toBeGreaterThanOrEqual(
      Math.min(240, bannerBox.width * 0.6),
    );
    // Compact: at most a third of the shortest screens, a fifth of a desktop window.
    expect(bannerBox.height).toBeLessThanOrEqual(
      size.height * (size.width >= 1024 ? 0.2 : 0.3),
    );
    expect(stopBox.y + stopBox.height).toBeLessThanOrEqual(size.height);
    expect(stopBox.x + stopBox.width).toBeLessThanOrEqual(size.width);
    // First in tab order: nothing has focus yet after the page loads.
    await page.keyboard.press("Tab");
    await expect(stop).toBeFocused();
    // Below dialogs: an open dialog covers the banner.
    const narrow = size.width < 768;
    await navigate(page, "My files", narrow);
    await page
      .getByRole("button", {
        name: narrow ? "New file or folder" : "New",
        exact: true,
      })
      .click();
    await page
      .getByRole(narrow ? "button" : "menuitem", {
        name: "New folder",
        exact: true,
      })
      .click();
    await expect(
      page.getByRole("dialog", { name: "New folder", exact: true }),
    ).toBeVisible();
    // The open modal hides the rest of the page from assistive technology, banner included.
    await expect(banner).toBeHidden();
    const covered = await page
      .locator('section[aria-label="Impersonation"]')
      .evaluate((element) => {
        const box = element.getBoundingClientRect();
        const top = document.elementFromPoint(
          box.left + box.width / 2,
          box.top + box.height / 2,
        );
        return top !== null && !element.contains(top);
      });
    expect(covered).toBe(true);
  });

/** Whether a click at the element's centre reaches the element itself. */
const reachable = (locator: Locator) =>
  locator.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const top = document.elementFromPoint(
      box.left + box.width / 2,
      box.top + box.height / 2,
    );
    return top !== null && element.contains(top);
  });

test("a persistent error toast leaves the banner, New button and selection bar reachable at 320 wide", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, "Selecting with modifier keys is a desktop interaction.");
  await page.setViewportSize({ width: 320, height: 640 });
  await impersonate(page);
  await page.goto("/");
  const banner = page.getByRole("region", { name: "Impersonation" });
  await expect(banner).toBeVisible();
  await navigate(page, "My files", true);
  const folder = `toast-${randomUUID().slice(0, 8)}`;
  await createFolder(page, folder, true);
  const select = () =>
    page
      .locator(`[data-entry-name="${folder}"]`)
      .filter({ visible: true })
      .click({ modifiers: ["ControlOrMeta"] });
  const bar = page.getByRole("toolbar", { name: "Selected items" });
  await select();
  await expect(bar).toBeVisible();
  const star = bar.getByRole("button", { name: "Star", exact: true });
  await star.click();
  const notifications = page.getByRole("region", { name: "Notifications" });
  await expect(notifications.getByText("Starred")).toBeVisible();
  // A pointer resting on a toast keeps it open.
  await page.mouse.move(160, 100);
  await expect(notifications.getByText("Starred")).toBeHidden();
  // Unstarring fails, so an error toast stays until it is closed.
  const unstar = bar.getByRole("button", { name: "Remove star", exact: true });
  await expect(unstar).toBeVisible();
  const starring = (url: URL) => url.pathname.includes("catalog.bookmark");
  await page.route(starring, (route) => route.abort());
  await unstar.click();
  // Only a toast that stays until closed has a close button. Base UI hides it from assistive
  // technology until the toast area has focus, so it is found by its slot.
  const close = page.locator('[data-slot="toast-close"]');
  await expect(close).toBeVisible();
  const toast = page.locator('[data-slot="toast"]').filter({ has: close });
  // Measured where the toast settles, after it slides in.
  const settled = () =>
    toast.evaluate((element) =>
      Promise.all(
        element.getAnimations().map((animation) => animation.finished),
      ),
    );
  await settled();
  const clear = async (controls: Locator[]) => {
    for (const control of [...controls, close]) {
      await expect(control).toBeVisible();
      expect(await reachable(control)).toBe(true);
      if (control !== close) expect(await overlap(control, toast)).toBe(false);
    }
  };
  const stop = banner.getByRole("button", {
    name: "Stop impersonating",
    exact: true,
  });
  // In a folder: the New button, and the selection bar in the header.
  await clear([
    stop,
    page.getByRole("button", { name: "New file or folder", exact: true }),
    bar.getByRole("button", { name: "Clear selection", exact: true }),
  ]);
  await close.click();
  await expect(close).toBeHidden();
  // In Starred: the selection bar floats at the bottom.
  await page.unroute(starring);
  await navigate(page, "Starred", true);
  await select();
  await expect(bar).toBeVisible();
  await page.route(starring, (route) => route.abort());
  await unstar.click();
  await expect(close).toBeVisible();
  await settled();
  await clear([
    stop,
    bar.getByRole("button", { name: "Clear selection", exact: true }),
    bar.getByRole("button", { name: "Trash", exact: true }),
  ]);
});
