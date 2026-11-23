import { expect, test } from "bun:test";
import type { Bootstrap } from "@/client/bootstrap";
import { PageSkeleton } from "./page-skeleton";

const session = {
  user: { id: "u1", name: "Nova", email: "nova@example.test" },
  impersonatedBy: null,
} as const;
const me = (isAdmin: boolean) => ({
  id: "u1",
  name: "Nova",
  email: "nova@example.test",
  role: isAdmin ? "admin" : "user",
  banned: false,
  isAdmin,
  home: null,
  top: "",
});
const prefs = (view: "list" | "grid") =>
  ({
    view,
    sortField: "name",
    sortDirection: "asc",
    groupByType: false,
  }) as const;

const folder = (data: Bootstrap, path = "/browse/Notes") =>
  PageSkeleton.markup("files", { folder: true, data }, path);

test("a folder's skeleton follows the account's view and sort order, and its role", () => {
  const list = folder({ session, prefs: prefs("list"), me: me(false) });
  const grid = folder({ session, prefs: prefs("grid"), me: me(true) });
  expect(list).toStartWith(
    '<div inert="" aria-hidden="true" data-skeleton="">',
  );
  expect(list).toContain('data-entry-skeleton="list"');
  expect(grid).toContain('data-entry-skeleton="grid"');
  // The sort control shows the account's own order, as the page will.
  expect(list).toContain("Name (A to Z)");
  // Only administrators have the storage summary, which keeps its shape while it loads.
  expect(list).not.toContain('aria-label="Storage usage"');
  expect(grid).toContain('aria-label="Storage usage"');
  // The account menu's letter.
  expect(list).toContain(">N<");
});

test("other files pages keep the title's place where they have one", () => {
  const page = (path: string) =>
    PageSkeleton.markup(
      "files",
      { folder: false, data: { session, prefs: prefs("list"), me: me(false) } },
      path,
    );
  expect(page("/trash")).toContain("data-trash-placeholder");
  expect(page("/recent")).toContain('data-entry-skeleton="list"');
  expect(page("/shared")).not.toContain("data-entry-skeleton");
});

test("settings show the page's name, and Administration only to administrators", () => {
  const settings = (isAdmin: boolean, path: string) =>
    PageSkeleton.markup(
      "settings",
      { folder: false, data: { session, me: me(isAdmin) } },
      path,
    );
  expect(settings(false, "/settings/webdav")).toContain("WebDAV");
  expect(settings(false, "/settings/webdav")).not.toContain("Administration");
  expect(settings(true, "/settings/admin")).toContain("Users &amp; groups");
});

test("the markup survives the browser's parser: no block inside a paragraph", () => {
  for (const html of [
    folder({ session, prefs: prefs("list"), me: me(true) }),
    folder({ session, prefs: prefs("grid"), me: me(true) }),
    PageSkeleton.markup(
      "files",
      { folder: false, data: { session, me: me(true) } },
      "/trash",
    ),
    PageSkeleton.markup(
      "settings",
      { folder: false, data: { session, me: me(true) } },
      "/settings/account",
    ),
  ])
    expect(html).not.toMatch(
      /<p\b[^>]*>(?:(?!<\/p>).)*<(?:div|ul|section|header)\b/,
    );
});

test("pages without a session, and public pages, have no skeleton", () => {
  expect(folder({ prefs: prefs("list") })).toBe("");
  expect(
    PageSkeleton.markup("public", { folder: false, data: {} }, "/s/x"),
  ).toBe("");
  expect(PageSkeleton.markup(null, { folder: false, data: {} }, "/")).toBe("");
});
