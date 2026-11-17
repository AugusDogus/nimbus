import { expect, test } from "bun:test";
import { PageSkeleton } from "./page-skeleton";

test("signed-in pages follow the folder view, and other pages have no skeleton", () => {
  const folder = (view: "list" | "grid") =>
    PageSkeleton.markup("files", {
      folder: true,
      data: {
        prefs: {
          view,
          sortField: "name",
          sortDirection: "asc",
          groupByType: false,
        },
      },
    });
  expect(folder("grid")).not.toBe(folder("list"));
  for (const html of [folder("list"), folder("grid")])
    expect(
      html.startsWith('<div inert="" aria-hidden="true" data-skeleton="">'),
    ).toBe(true);
  expect(PageSkeleton.markup("public", { folder: false, data: {} })).toBe("");
  expect(PageSkeleton.markup(null, { folder: false, data: {} })).toBe("");
});
