import { randomUUID } from "node:crypto";
import { expect, type Page } from "@playwright/test";
import { client, test } from "./helpers";

// Recent, Starred, Shared, search results and Trash order and show their items as folders do:
// the folder's sort control with each page's own orders, its default in the address as nothing,
// and, but for Trash, the account's list or grid view.

/** The names the page lists that start with `prefix`, in reading order. */
const shown = (page: Page, prefix: string) =>
  page.locator("[data-entry-row] [data-entry-name]").evaluateAll(
    (rows, prefix) =>
      rows
        .map((row) => ({
          name: row.getAttribute("data-entry-name") ?? "",
          box: row.getBoundingClientRect(),
        }))
        .filter((row) => row.name.startsWith(prefix))
        .sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x)
        .map((row) => row.name.slice(prefix.length)),
    prefix,
  );

/** Whether entries sit side by side, as grid cards do. */
const isGrid = (page: Page) =>
  page.locator("[data-entry-row]").evaluateAll((rows) => {
    const tops = rows.map((row) => Math.round(row.getBoundingClientRect().y));
    return new Set(tops).size < tops.length;
  });

/** Chooses an order from the sort menu, or on phones from the sort and filter drawer. */
async function sortBy(page: Page, label: string, isMobile: boolean) {
  if (isMobile) {
    await page
      .getByRole("button", { name: "Sort and filter options", exact: true })
      .click();
    await page
      .getByRole("dialog", { name: "Sort & filter", exact: true })
      .getByRole("group", { name: "Sort by" })
      .getByRole("button", { name: label, exact: true })
      .click();
  } else {
    await page.getByRole("combobox", { name: "Sort files" }).click();
    await page.getByRole("option", { name: label, exact: true }).click();
  }
}

/**
 * Three folders named `<tag>-Cherry`, `-Apple` and `-Banana`, opened in that order and each
 * starred. Tests share one account, so each tags its own.
 */
async function threeOpened(page: Page) {
  const rpc = await client(page.context());
  const tag = `lists${randomUUID().slice(0, 8)}-`;
  const top = `${tag}top`;
  await rpc.files.createFolder.mutate({ name: top });
  for (const name of ["Cherry", "Apple", "Banana"]) {
    const path = `${top}/${tag}${name}`;
    await rpc.files.createFolder.mutate({ path: top, name: `${tag}${name}` });
    await rpc.catalog.bookmark.mutate({ path });
    await rpc.catalog.bookmark.mutate({ path, starred: true });
  }
  const prefs = await rpc.prefs.get.query();
  return { rpc, tag, restore: () => rpc.prefs.set.mutate(prefs), prefs };
}

const entry = (page: Page, name: string) =>
  page.locator(`[data-entry-name="${name}"]`).filter({ visible: true });

test("Recent shows the most recent first, sorts by name from its address, and shows cards in the account's view", async ({
  page,
  isMobile,
}) => {
  const { rpc, tag, restore, prefs } = await threeOpened(page);
  try {
    await rpc.prefs.set.mutate({ ...prefs, view: "list" });
    await page.goto("/recent");
    await expect(entry(page, `${tag}Banana`)).toBeVisible();
    // Banana was opened last, then Apple, then Cherry.
    expect(await shown(page, tag)).toEqual(["Banana", "Apple", "Cherry"]);
    await sortBy(page, "Name (A to Z)", isMobile);
    await expect(page).toHaveURL(/\/recent\?sort=name-asc$/);
    await expect
      .poll(() => shown(page, tag))
      .toEqual(["Apple", "Banana", "Cherry"]);
    // A link shows the same order.
    await page.reload();
    await expect(entry(page, `${tag}Apple`)).toBeVisible();
    expect(await shown(page, tag)).toEqual(["Apple", "Banana", "Cherry"]);
    // Back to the default: the address carries nothing.
    await sortBy(page, "Most recent", isMobile);
    await expect(page).toHaveURL(/\/recent$/);
    await expect
      .poll(() => shown(page, tag))
      .toEqual(["Banana", "Apple", "Cherry"]);

    await page.getByRole("button", { name: "Grid view", exact: true }).click();
    await expect.poll(() => isGrid(page)).toBe(true);
    // The account's view, so folders show cards now too.
    await expect
      .poll(async () => (await rpc.prefs.get.query()).view)
      .toBe("grid");
  } finally {
    await restore();
  }
});

test("Starred in grid view keeps its order, item menus and selection", async ({
  page,
  isMobile,
}) => {
  const { rpc, tag, restore, prefs } = await threeOpened(page);
  try {
    await rpc.prefs.set.mutate({ ...prefs, view: "grid" });
    await page.goto("/starred?sort=name-desc");
    const cherry = entry(page, `${tag}Cherry`);
    await expect(cherry).toBeVisible();
    expect(await isGrid(page)).toBe(true);
    expect(await shown(page, tag)).toEqual(["Cherry", "Banana", "Apple"]);
    if (!isMobile) {
      await cherry.click({ modifiers: ["ControlOrMeta"] });
      await expect(
        page.getByRole("toolbar", { name: "Selected items" }),
      ).toBeVisible();
      // Arrow keys move along the cards: Right from Cherry reaches Banana.
      await cherry.focus();
      await page.keyboard.press("ArrowRight");
      await expect(entry(page, `${tag}Banana`)).toBeFocused();
      await page.keyboard.press("Escape");
    }
    await page
      .getByRole("button", { name: `Actions for ${tag}Cherry`, exact: true })
      .filter({ visible: true })
      .first()
      .click();
    await expect(
      page
        .getByRole("menuitem", { name: "Rename" })
        .or(page.getByRole("button", { name: "Rename", exact: true }))
        .filter({ visible: true })
        .first(),
    ).toBeVisible();
  } finally {
    await restore();
  }
});

test("search results sort by name across every match, not just the page shown", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, "One device is enough for the paging.");
  const rpc = await client(page.context());
  const top = `sortsearch${randomUUID().slice(0, 8)}`;
  await rpc.files.createFolder.mutate({ name: top });
  // More matches than one page of 200.
  for (let index = 0; index < 230; index++)
    await rpc.files.createFolder.mutate({
      path: top,
      name: `${top} item ${String(index).padStart(3, "0")}`,
    });
  await page.goto(`/search?q=${top}%20item`);
  await expect(page.getByText(/Showing 200 of/)).toBeVisible();
  await sortBy(page, "Name (Z to A)", isMobile);
  await expect(page).toHaveURL(/sort=name-desc/);
  // Every match loads before sorting, so the last name of all leads.
  await expect
    .poll(async () => (await shown(page, `${top} item `)).slice(0, 2))
    .toEqual(["229", "228"]);
});

test("Trash shows the most recently deleted first, sorts by name, and is a list only", async ({
  page,
  isMobile,
}) => {
  const rpc = await client(page.context());
  const top = `trashsort-${randomUUID()}`;
  await rpc.files.createFolder.mutate({ name: top });
  for (const name of ["zeta", "alpha", "mu"]) {
    await rpc.files.createFolder.mutate({ path: top, name });
    await rpc.files.delete.mutate({ path: `${top}/${name}` });
  }
  await page.goto("/trash");
  const ours = () =>
    page.locator("[data-trash-item]").evaluateAll(
      // Each row names the item, then where it was.
      (items, place) =>
        items.flatMap((item) => {
          const line = item.querySelector("p");
          const where = line?.querySelector("span")?.textContent;
          return where === place ? [line?.firstChild?.textContent ?? ""] : [];
        }),
      `Files / ${top}`,
    );
  await expect.poll(ours).toEqual(["mu", "alpha", "zeta"]);
  await sortBy(page, "Name (A to Z)", isMobile);
  await expect(page).toHaveURL(/\/trash\?sort=name-asc$/);
  await expect.poll(ours).toEqual(["alpha", "mu", "zeta"]);
  await expect(
    page.getByRole("button", { name: "Grid view", exact: true }),
  ).toHaveCount(0);
});
