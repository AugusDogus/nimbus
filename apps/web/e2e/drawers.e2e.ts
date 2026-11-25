import { randomUUID } from "node:crypto";
import { expect, type Locator } from "@playwright/test";
import { client, test } from "./helpers";

/**
 * Whether `item` is on screen, or a user can scroll it there. Scripts can scroll even an
 * `overflow: hidden` box, so this scrolls with the wheel, as a person would.
 */
async function reachable(item: Locator) {
  const page = item.page();
  const height = page.viewportSize()?.height ?? 0;
  const width = page.viewportSize()?.width ?? 0;
  const visible = async () => {
    const box = await item.boundingBox();
    return box !== null && box.y >= 0 && box.y + box.height <= height;
  };
  await page.mouse.move(width / 2, height - 40);
  for (let attempt = 0; attempt < 5 && !(await visible()); attempt++) {
    await page.mouse.wheel(0, 400);
    await page.waitForTimeout(100);
  }
  return visible();
}

for (const size of [
  { width: 375, height: 560 },
  { width: 320, height: 480 },
])
  test(`every drawer action is reachable on a ${size.width}x${size.height} screen`, async ({
    page,
    context,
    hasTouch,
  }) => {
    test.skip(
      !hasTouch,
      "Item actions open in a drawer only where the pointer is a finger.",
    );
    await page.setViewportSize(size);
    const folder = `drawer-${randomUUID()}`;
    await (await client(context)).files.createFolder.mutate({ name: folder });
    await page.goto("/");
    await page
      .getByRole("button", { name: `Actions for ${folder}`, exact: true })
      .click();
    const actions = page.getByRole("dialog", { name: folder, exact: true });
    const trash = actions.getByRole("button", {
      name: "Move to trash",
      exact: true,
    });
    expect(await reachable(trash)).toBe(true);
    expect(
      await reachable(
        actions.getByRole("button", { name: "Rename", exact: true }),
      ),
    ).toBe(true);
    await trash.click();
    await expect(
      page.getByRole("alertdialog").or(page.getByText("Moved")).first(),
    ).toBeVisible();

    await page.goto("/");
    await page
      .getByRole("button", { name: "Sort and filter options", exact: true })
      .click();
    const sort = page.getByRole("dialog", {
      name: "Sort & filter",
      exact: true,
    });
    expect(
      await reachable(
        sort.getByRole("button", { name: "Group by type", exact: true }),
      ),
    ).toBe(true);
  });

test("the sort drawer tells screen readers which choices are on", async ({
  page,
  context,
}) => {
  // A narrow window gathers sort and filters in one drawer, whatever the pointer.
  await page.setViewportSize({ width: 375, height: 700 });
  await (
    await client(context)
  ).prefs.set.mutate({
    view: "list",
    sortField: "name",
    sortDirection: "asc",
    groupByType: true,
  });
  await page.goto("/");
  await page
    .getByRole("button", { name: "Sort and filter options", exact: true })
    .click();
  const sort = page.getByRole("dialog", { name: "Sort & filter", exact: true });
  // Plain buttons, each applying its order and closing the drawer, with their state announced.
  const options = sort.getByRole("group", { name: "Sort by" });
  await expect(options.getByRole("button", { pressed: true })).toHaveText(
    "Name (A to Z)",
  );
  await expect(options.getByRole("button", { pressed: false })).toHaveCount(7);
  await expect(
    sort.getByRole("button", { name: "Group by type", pressed: true }),
  ).toBeVisible();
});
