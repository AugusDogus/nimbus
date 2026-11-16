import { expect, test } from "bun:test";
import { PageSkeleton } from "./page-skeleton";

const signInOptions = {
  setupAvailable: false,
  singleSignOn: null,
  passwordReset: false,
};
const at = (path: string) => new URL(path, "http://localhost");

test("sign-in shows its real card's size, with its fields hidden and inert", () => {
  const html = PageSkeleton.markup("auth", at("/login"), {
    folder: false,
    data: { signInOptions },
  });
  expect(
    html.startsWith(
      '<style>[data-skeleton] [data-slot=card]>*{visibility:hidden}</style><div inert="" aria-hidden="true" data-skeleton="">',
    ),
  ).toBe(true);
  expect(html).toContain("Welcome back");
  expect(html).toContain(">Sign in</button>");
  expect(
    PageSkeleton.markup("auth", at("/login?callbackURL=%2Fsettings"), {
      folder: false,
      data: { signInOptions },
    }),
  ).toBe(html);
});

test("sign-in pages whose content the server cannot predict show no card", () => {
  for (const path of ["/login?error=banned", "/signup", "/reset-password"])
    expect(
      PageSkeleton.markup("auth", at(path), {
        folder: false,
        data: { signInOptions },
      }),
    ).toBe("");
});

test("signed-in pages follow the folder view, and other pages have no skeleton", () => {
  const folder = (view: "list" | "grid") =>
    PageSkeleton.markup("files", at("/browse/a"), {
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
  expect(
    PageSkeleton.markup("public", at("/s/token"), { folder: false, data: {} }),
  ).toBe("");
  expect(
    PageSkeleton.markup(null, at("/nowhere"), { folder: false, data: {} }),
  ).toBe("");
});
