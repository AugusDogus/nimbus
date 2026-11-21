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
