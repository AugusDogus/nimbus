import { expect, type Page } from "@playwright/test";
import { test } from "./helpers";

// Files, Recent, Starred, Shared, Trash and search results share one card and header: the same
// row, the title where a folder's path goes, and sort and view at the row's end.

type Box = {
  x: number;
  y: number;
  width: number;
  height: number;
  right: number;
};
type Header = {
  row: Box;
  title: Box;
  sort: Box | null;
  view: Box | null;
};

const pages = [
  { path: "/", title: "Files" },
  { path: "/recent", title: "Recent" },
  { path: "/starred", title: "Starred" },
  { path: "/shared", title: "Shared" },
  { path: "/trash", title: "Trash" },
  { path: "/search?q=alpha", title: "Search: alpha" },
] as const;

/** The header's parts on the page shown: its row, its title, and its sort and view controls. */
async function header(page: Page, sortLabel: string): Promise<Header> {
  return page.evaluate((sortLabel) => {
    const box = (element: Element | null | undefined) => {
      if (!element) return null;
      const { x, y, width, height, right } = element.getBoundingClientRect();
      return width > 0 && height > 0 ? { x, y, width, height, right } : null;
    };
    const row = document.querySelector('[data-shape="folder-toolbar"]');
    const shown = (selector: string) =>
      [...(row?.querySelectorAll(selector) ?? [])].find(
        (element) => box(element) !== null,
      );
    const rowBox = box(row);
    const title = box(row?.querySelector('[data-shape="crumbs"] h1'));
    if (!rowBox || !title)
      throw new Error("The page shows no card header with a title.");
    return {
      row: rowBox,
      title,
      sort: box(shown(`[aria-label="${sortLabel}"]`)),
      view: box(shown('[data-shape="view"]')),
    };
  }, sortLabel);
}

/** Boxes more than a pixel apart in any of `keys`, named. */
function apart(
  name: string,
  one: Box | null,
  other: Box | null,
  keys: readonly (keyof Box)[],
) {
  if (!one || !other) return one === other ? [] : [`${name}: on one page only`];
  return keys
    .filter((key) => Math.abs(one[key] - other[key]) > 1)
    .map((key) => `${name} ${key}: ${one[key]} vs ${other[key]}`);
}

test("every files page has the folder's header, its title, sort and view in the same places", async ({
  page,
  isMobile,
}) => {
  // On a phone the sort and filter drawer holds the sort and the view alike.
  const sortLabel = isMobile ? "Sort and filter options" : "Sort files";
  const seen: Record<string, Header> = {};
  for (const { path, title } of pages) {
    await page.goto(path);
    await expect(
      page.locator('[data-shape="crumbs"] h1').filter({ hasText: title }),
    ).toBeVisible();
    await expect(page.locator("[data-skeleton]")).toHaveCount(0);
    seen[path] = await header(page, sortLabel);
  }
  const files = seen["/"];
  if (!files) throw new Error("Files was not measured.");
  const off = Object.entries(seen).flatMap(([path, each]) =>
    [
      ...apart("row", files.row, each.row, ["x", "y", "width", "height"]),
      ...apart("title", files.title, each.title, ["x", "y", "height"]),
      // The sort control sits on the same line everywhere. Along it, a folder's Group by type
      // and Split, and Trash's Empty trash, come after it, so it ends in one place across the
      // list pages, however long the name of their order.
      ...apart("sort", files.sort, each.sort, ["y", "height"]),
      // Trash lists rows only, with no view to choose.
      ...(path === "/trash"
        ? []
        : apart("view", files.view, each.view, ["x", "y", "width", "height"])),
    ].map((line) => `${path}: ${line}`),
  );
  const lists = ["/recent", "/starred", "/shared", "/search?q=alpha"] as const;
  const recent = seen["/recent"];
  for (const path of lists)
    off.push(
      ...apart("sort", recent?.sort ?? null, seen[path]?.sort ?? null, [
        "right",
      ]).map((line) => `${path}: ${line}`),
    );
  expect(off, "Header parts that differ from the folder's").toEqual([]);
  expect(files.sort).not.toBeNull();
  // Phones offer the view in the sort and filter drawer, as a folder's.
  if (isMobile) expect(files.view).toBeNull();
  else expect(files.view).not.toBeNull();
});
