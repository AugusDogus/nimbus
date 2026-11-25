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
  PageSkeleton.markup(
    "files",
    { folder: true, data },
    path,
    null,
    new URLSearchParams(),
  );

test("a folder's skeleton follows the account's view and sort order, and its role", () => {
  const list = folder({ session, prefs: prefs("list"), me: me(false) });
  const grid = folder({ session, prefs: prefs("grid"), me: me(true) });
  // Fluid Functionalism's scroll area adds a style of Base UI's ahead of it.
  expect(list).toContain('<div inert="" aria-hidden="true" data-skeleton="">');
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

test("the skeleton shows the sidebar as the person left it", () => {
  const data = { session, prefs: prefs("list"), me: me(false) };
  const at = (cookie: string | null) =>
    PageSkeleton.markup(
      "files",
      { folder: true, data },
      "/browse/Notes",
      cookie,
      new URLSearchParams(),
    );
  expect(at(null)).toContain('data-state="expanded"');
  expect(at("theme=dark; sidebar_state=false")).toContain(
    'data-state="collapsed"',
  );
  expect(at("sidebar_state=true")).toContain('data-state="expanded"');
});

test("other files pages keep the title's place where they have one", () => {
  const page = (path: string) =>
    PageSkeleton.markup(
      "files",
      { folder: false, data: { session, prefs: prefs("list"), me: me(false) } },
      path,
      null,
      new URLSearchParams(),
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
      null,
      new URLSearchParams(),
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
      null,
      new URLSearchParams(),
    ),
    PageSkeleton.markup(
      "settings",
      { folder: false, data: { session, me: me(true) } },
      "/settings/account",
      null,
      new URLSearchParams(),
    ),
  ])
    expect(html).not.toMatch(
      /<p\b[^>]*>(?:(?!<\/p>).)*<(?:div|ul|section|header)\b/,
    );
});

test("pages without a session, and public pages, have no skeleton", () => {
  expect(folder({ prefs: prefs("list") })).toBe("");
  expect(
    PageSkeleton.markup(
      "public",
      { folder: false, data: {} },
      "/s/x",
      null,
      new URLSearchParams(),
    ),
  ).toBe("");
  expect(
    PageSkeleton.markup(
      null,
      { folder: false, data: {} },
      "/",
      null,
      new URLSearchParams(),
    ),
  ).toBe("");
});

test("a list page's skeleton shows the account's view and the order its address names", () => {
  const at = (path: string, view: "list" | "grid", sort: string | null) =>
    PageSkeleton.markup(
      "files",
      { folder: false, data: { session, prefs: prefs(view), me: me(false) } },
      path,
      null,
      new URLSearchParams(sort === null ? {} : { sort }),
    );
  // The default order, then another the address names, on Recent.
  expect(at("/recent", "list", null)).toContain("Most recent");
  expect(at("/recent", "list", "size-desc")).toContain("Size (Largest)");
  // Search starts by relevance, Starred by name, as folders do.
  expect(at("/search", "list", null)).toContain("Relevance");
  expect(at("/starred", "list", "nonsense")).toContain("Name (A to Z)");
  // Placeholders in the view the account chose.
  expect(at("/starred", "grid", null)).not.toEqual(
    at("/starred", "list", null),
  );
});

test("Trash's skeleton shows the order its address names, the most recently deleted first by default", () => {
  const at = (sort: string | null) =>
    PageSkeleton.markup(
      "files",
      { folder: false, data: { session, prefs: prefs("list"), me: me(false) } },
      "/trash",
      null,
      new URLSearchParams(sort === null ? {} : { sort }),
    );
  expect(at(null)).toContain("Deleted (Newest)");
  expect(at("expires-asc")).toContain("Expires (Soonest)");
});

test("a search's skeleton is titled by what it looks for", () => {
  expect(
    PageSkeleton.markup(
      "files",
      { folder: false, data: { session, prefs: prefs("list"), me: me(false) } },
      "/search",
      null,
      new URLSearchParams({ q: "quarterly <report>" }),
    ),
  ).toContain("Search: quarterly &lt;report&gt;");
});
