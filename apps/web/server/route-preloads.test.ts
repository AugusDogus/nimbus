import { describe, expect, test } from "bun:test";
import { RoutePreloads } from "./route-preloads";

const split = (file: string, chunk: string, imports: string[] = []) => ({
  [`routes/${file}?tsr-split=component`]: { file: chunk, imports },
});

const preloads = RoutePreloads.fromManifest({
  "index.html": { file: "assets/index.js", imports: ["_react.js"] },
  "_react.js": { file: "assets/react.js" },
  "_ui.js": { file: "assets/ui.js", imports: ["_react.js"] },
  ...split("_authed.tsx", "assets/authed.js"),
  ...split("_authed/_files.tsx", "assets/files-layout.js", ["_ui.js"]),
  ...split("_authed/_files/index.tsx", "assets/root.js"),
  ...split("_authed/_files/browse/$.tsx", "assets/browse.js"),
  ...split("_authed/_files/search.tsx", "assets/search.js"),
  ...split("login.tsx", "assets/login.js", ["_ui.js"]),
  ...split("s/$token.tsx", "assets/share.js"),
});

const hrefs = (pathname: string) =>
  [...preloads.links(pathname).matchAll(/href="([^"]+)"/g)].map(
    (match) => match[1],
  );

describe("RoutePreloads", () => {
  test("lists a page's route chunks and their imports, but not the entry's", () => {
    expect(hrefs("/browse/a/b%20c")).toEqual([
      "/api/auth/get-session",
      "/api/trpc/prefs.get?batch=1&input=%7B%7D",
      "/assets/authed.js",
      "/assets/files-layout.js",
      "/assets/ui.js",
      "/assets/browse.js",
    ]);
    expect(hrefs("/")).toContain("/assets/root.js");
    expect(hrefs("/login")).toEqual(["/assets/login.js", "/assets/ui.js"]);
  });

  test("prefers a literal route over a splat and preloads a share's listing", () => {
    expect(hrefs("/search")).toContain("/assets/search.js");
    expect(hrefs("/s/abc%2D_x")).toEqual([
      "/api/share/abc-_x?path=",
      "/assets/share.js",
    ]);
  });

  test("names nothing for addresses outside the app", () => {
    expect(preloads.links("/nowhere/at/all")).toBe("");
    expect(preloads.links('/s/a"b<c')).not.toContain('"b<');
  });
});
