import { describe, expect, it } from "bun:test";
import { BreadcrumbTrail } from "./breadcrumb-trail";
import { fileHref } from "./types";

const trail = (folder: string, top: string) =>
  BreadcrumbTrail.of(folder, top, "Files");
const hrefs = (built: BreadcrumbTrail) =>
  [built.root, ...built.crumbs].map((crumb) => [
    crumb.label,
    fileHref(crumb.path),
  ]);

describe("the breadcrumb trail", () => {
  it("shows the real ancestry under the drive root", () => {
    expect(hrefs(trail("", ""))).toEqual([["Files", "/"]]);
    expect(hrefs(trail("users/augie/Projects", ""))).toEqual([
      ["Files", "/"],
      ["users", "/browse/users"],
      ["augie", "/browse/users/augie"],
      ["Projects", "/browse/users/augie/Projects"],
    ]);
  });

  it("roots at the home folder when that is the top, linking every crumb to its real folder", () => {
    expect(hrefs(trail("users/ann", "users/ann"))).toEqual([
      ["Files", "/browse/users/ann"],
    ]);
    expect(hrefs(trail("users/ann/Photos", "users/ann"))).toEqual([
      ["Files", "/browse/users/ann"],
      ["Photos", "/browse/users/ann/Photos"],
    ]);
  });

  it("keeps names with spaces and characters that need encoding, under any home container", () => {
    expect(
      hrefs(
        trail("team/people/ann b/Trip 100% #1/day%202", "team/people/ann b"),
      ),
    ).toEqual([
      ["Files", "/browse/team/people/ann%20b"],
      ["Trip 100% #1", "/browse/team/people/ann%20b/Trip%20100%25%20%231"],
      ["day%202", "/browse/team/people/ann%20b/Trip%20100%25%20%231/day%25202"],
    ]);
  });

  it("does not mistake a sibling whose name starts with the home's for the home", () => {
    expect(hrefs(trail("users/ann2/x", "users/ann"))).toEqual([
      ["Files", "/"],
      ["users", "/browse/users"],
      ["ann2", "/browse/users/ann2"],
      ["x", "/browse/users/ann2/x"],
    ]);
  });
});

describe("a path named as the breadcrumb names it", () => {
  it("spells a location from the account's top folder, which reads as Files", () => {
    expect(BreadcrumbTrail.spell("users/ann", "users/ann")).toBe("Files");
    expect(BreadcrumbTrail.spell("users/ann/Photos/2025", "users/ann")).toBe(
      "Files / Photos / 2025",
    );
    // Outside the top, and for an account whose top is the drive root, from the drive root.
    expect(BreadcrumbTrail.spell("Studio/Brand", "users/ann")).toBe(
      "Files / Studio / Brand",
    );
    expect(BreadcrumbTrail.spell("users/ann", "")).toBe("Files / users / ann");
    expect(BreadcrumbTrail.spell("", "")).toBe("Files");
  });

  it("names a folder as its last crumb: Files for the top and the drive root", () => {
    expect(BreadcrumbTrail.name("users/ann", "users/ann")).toBe("Files");
    expect(BreadcrumbTrail.name("", "users/ann")).toBe("Files");
    expect(BreadcrumbTrail.name("users/ann/Photos", "users/ann")).toBe(
      "Photos",
    );
    expect(BreadcrumbTrail.name("users/ann", "")).toBe("ann");
  });

  it("places each crumb at its offset in the path, for marking matches in it", () => {
    expect(
      BreadcrumbTrail.spelled("users/ann/Photos/2025", "users/ann").map(
        (part) => [part.label, part.at],
      ),
    ).toEqual([
      ["Files", null],
      ["Photos", 10],
      ["2025", 17],
    ]);
    expect(
      BreadcrumbTrail.spelled("Studio", "").map((part) => [
        part.label,
        part.at,
      ]),
    ).toEqual([
      ["Files", null],
      ["Studio", 0],
    ]);
  });
});
