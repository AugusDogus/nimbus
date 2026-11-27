import { expect, type Page } from "@playwright/test";
import { test } from "./helpers";

// The rail on the sidebar's inner edge: drag it to resize the sidebar, or past the minimum to
// collapse it; click it to collapse it; or use it from the keyboard. The width is remembered, and
// the page the server sends draws the sidebar at it before the app runs.

const column = (page: Page) => page.locator('[data-slot="sidebar"]');
const rail = (page: Page) => page.locator('[data-sidebar="rail"]');

const columnWidth = (page: Page) =>
  column(page).evaluate((element) => element.getBoundingClientRect().width);

async function cookie(page: Page, name: string) {
  const cookies = await page.context().cookies();
  return cookies.find((each) => each.name === name)?.value;
}

/** Opens the files home and waits for the app to have taken over from its skeleton. */
async function home(page: Page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Account menu" }),
  ).toBeVisible();
  await expect(page.locator("[data-skeleton]")).toHaveCount(0);
  await expect(column(page)).toHaveAttribute("data-state", "expanded");
}

/** Presses the rail and drags it `by` pixels outward, without letting go. */
async function dragRail(page: Page, by: number) {
  const box = await rail(page).boundingBox();
  if (!box) throw new Error("The sidebar's rail is not on the page.");
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + by, y, { steps: 8 });
}

test.describe("the sidebar's rail", () => {
  test.beforeEach(({ isMobile }) => {
    test.skip(isMobile, "Phones keep the sidebar in a drawer, without a rail.");
  });

  test("dragging it resizes the sidebar, and a reload draws it at that width from the first paint", async ({
    page,
  }) => {
    await home(page);
    expect(await columnWidth(page)).toBe(256);
    await rail(page).hover();
    await expect(page.getByText("to resize")).toBeVisible();
    await dragRail(page, 64);
    // Dragging hides the tooltip, and the sidebar follows the pointer.
    await expect(page.getByText("to resize")).toBeHidden();
    await expect.poll(() => columnWidth(page)).toBe(320);
    await page.mouse.up();
    await expect.poll(() => cookie(page, "sidebar_width")).toBe("320");

    // The served page, before the app's code arrives.
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    await page.route(
      (url) =>
        url.pathname.startsWith("/assets/index-") &&
        url.pathname.endsWith(".js"),
      async (route) => {
        await held;
        await route.fallback();
      },
    );
    await page.reload({ waitUntil: "commit" });
    await page.locator("[data-skeleton]").waitFor();
    expect(await columnWidth(page)).toBe(320);
    const inset = page.locator('[data-slot="sidebar-inset"]');
    const before = await inset.boundingBox();
    release();
    await expect(page.locator("[data-skeleton]")).toHaveCount(0);
    expect(await columnWidth(page)).toBe(320);
    expect(await inset.boundingBox()).toEqual(before);
  });

  test("dragging it past the minimum collapses the sidebar", async ({
    page,
  }) => {
    await home(page);
    await dragRail(page, -120);
    // Held at its minimum until dragged well past it.
    await expect.poll(() => columnWidth(page)).toBe(160);
    await expect(column(page)).toHaveAttribute("data-state", "expanded");
    await page.mouse.move(0, 400, { steps: 8 });
    await expect(column(page)).toHaveAttribute("data-state", "collapsed");
    await page.mouse.up();
    await expect(column(page)).toHaveAttribute("data-state", "collapsed");
    await expect.poll(() => cookie(page, "sidebar_state")).toBe("false");
    await page.reload();
    await expect(column(page)).toHaveAttribute("data-state", "collapsed");
  });

  test("clicking it collapses the sidebar, and the toggle opens it as wide as it was", async ({
    page,
  }) => {
    await home(page);
    await dragRail(page, 40);
    await page.mouse.up();
    await expect.poll(() => columnWidth(page)).toBe(296);
    await rail(page).click();
    await expect(column(page)).toHaveAttribute("data-state", "collapsed");
    await expect.poll(() => columnWidth(page)).toBe(0);
    await page.getByRole("button", { name: "Toggle Sidebar" }).click();
    await expect(column(page)).toHaveAttribute("data-state", "expanded");
    await expect.poll(() => columnWidth(page)).toBe(296);
  });

  test("it works from the keyboard", async ({ page }) => {
    await home(page);
    // A tab stop while the sidebar is open: the arrow keys resize it, within the rail's bounds.
    await expect(rail(page)).toHaveAttribute("tabindex", "0");
    await rail(page).focus();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await expect.poll(() => columnWidth(page)).toBe(288);
    await page.keyboard.press("ArrowLeft");
    await expect.poll(() => columnWidth(page)).toBe(272);
    await expect.poll(() => cookie(page, "sidebar_width")).toBe("272");
    for (let press = 0; press < 30; press++)
      await page.keyboard.press("ArrowRight");
    await expect.poll(() => columnWidth(page)).toBe(360);
    // Enter collapses it and hands focus to the toggle, which opens it again.
    await page.keyboard.press("Enter");
    await expect(column(page)).toHaveAttribute("data-state", "collapsed");
    const toggle = page.getByRole("button", { name: "Toggle Sidebar" });
    await expect(toggle).toBeFocused();
    await expect(rail(page)).toHaveAttribute("tabindex", "-1");
    await page.keyboard.press("Enter");
    await expect(column(page)).toHaveAttribute("data-state", "expanded");
    await expect.poll(() => columnWidth(page)).toBe(360);
    // The bare "[" toggles it from anywhere outside a text field.
    await page.locator("body").press("[");
    await expect(column(page)).toHaveAttribute("data-state", "collapsed");
    await page.locator("body").press("[");
    await expect(column(page)).toHaveAttribute("data-state", "expanded");
  });

  test("the header's search stays centred on the window at every width", async ({
    page,
  }) => {
    await home(page);
    const search = page.locator('[data-shape="search"]');
    for (const [by, width] of [
      [-96, 160],
      [96, 256],
      [104, 360],
    ] as const) {
      await dragRail(page, by);
      await page.mouse.up();
      await expect.poll(() => columnWidth(page)).toBe(width);
      const box = await search.boundingBox();
      if (!box) throw new Error("The header's search is not on the page.");
      expect(Math.abs(box.x + box.width / 2 - 720)).toBeLessThanOrEqual(1);
    }
  });
});

test("phones open the sidebar as a drawer, without a rail", async ({
  page,
  isMobile,
}) => {
  test.skip(!isMobile, "The drawer is for phones.");
  await page.goto("/");
  await page.getByRole("button", { name: "Toggle Sidebar" }).click();
  const drawer = page.getByRole("dialog", { name: "Sidebar" });
  await expect(drawer).toBeVisible();
  await expect(drawer.locator('[data-sidebar="rail"]')).toHaveCount(0);
  await expect(rail(page)).toBeHidden();
});
