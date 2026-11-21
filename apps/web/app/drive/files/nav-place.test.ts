import { describe, expect, it } from "bun:test";
import { NavPlace } from "./nav-place";

describe("the sidebar item a page belongs to", () => {
  it("is Files on every folder view, inside a home folder or not", () => {
    for (const pathname of [
      "/",
      "/browse",
      "/browse/docs",
      "/browse/users",
      "/browse/users/admin",
      "/browse/users/admin/a/b",
      "/browse/users/alice",
      "/home",
    ])
      expect(NavPlace.of(pathname)).toBe("files");
  });

  it("is each library page's own item", () => {
    expect(NavPlace.of("/shared")).toBe("shared");
    expect(NavPlace.of("/recent")).toBe("recent");
    expect(NavPlace.of("/starred")).toBe("starred");
    expect(NavPlace.of("/trash")).toBe("trash");
    expect(NavPlace.of("/settings")).toBe("settings");
  });

  it("ignores a trailing slash, as the router does", () => {
    expect(NavPlace.of("/shared/")).toBe("shared");
    expect(NavPlace.of("/recent/")).toBe("recent");
    expect(NavPlace.of("/starred/")).toBe("starred");
    expect(NavPlace.of("/trash//")).toBe("trash");
    expect(NavPlace.of("/home/")).toBe("files");
    expect(NavPlace.of("/browse/users/admin/")).toBe("files");
    expect(NavPlace.of("/search/")).toBeNull();
  });

  it("is none for pages that are not a place in the sidebar", () => {
    expect(NavPlace.of("/search")).toBeNull();
    expect(NavPlace.of("/browsed")).toBeNull();
  });
});
