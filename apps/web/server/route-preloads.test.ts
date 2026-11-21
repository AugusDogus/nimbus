import { describe, expect, test } from "bun:test";
import { RoutePreloads } from "./route-preloads";

const split = (file: string, chunk: string, imports: string[] = []) => ({
  [`routes/${file}?tsr-split=component`]: { file: chunk, imports },
});

const routeFiles = [
  "_authed.tsx",
  "_authed/_files.tsx",
  "_authed/_files/index.tsx",
  "_authed/_files/browse/$.tsx",
  "_authed/_files/search.tsx",
  "_authed/_files/home.tsx",
  "_authed/_files/start.tsx",
  "login.tsx",
  "r/$token.tsx",
];

const preloads = RoutePreloads.fromManifest(
  {
    "index.html": { file: "assets/index.js", imports: ["_react.js"] },
    "_react.js": { file: "assets/react.js" },
    "_ui.js": { file: "assets/ui.js", imports: ["_react.js"] },
    ...split("_authed.tsx", "assets/authed.js"),
    ...split("_authed/_files.tsx", "assets/files-layout.js", ["_ui.js"]),
    ...split("_authed/_files/index.tsx", "assets/root.js"),
    ...split("_authed/_files/browse/$.tsx", "assets/browse.js"),
    ...split("_authed/_files/search.tsx", "assets/search.js"),
    ...split("login.tsx", "assets/login.js", ["_ui.js"]),
    ...split("r/$token.tsx", "assets/request.js"),
  },
  routeFiles,
);

const hrefs = (pathname: string, requests: string[] = []) =>
  [...preloads.links(pathname, requests).matchAll(/href="([^"]+)"/g)].map(
    (match) => match[1],
  );

describe("RoutePreloads", () => {
  test("names the kind of page an address is", () => {
    expect(preloads.match("/browse/x")?.kind).toBe("files");
    expect(preloads.match("/")?.kind).toBe("files");
    expect(preloads.match("/login")?.kind).toBe("public");
    expect(preloads.match("/r/abc")?.kind).toBe("public");
    expect(preloads.match("/nowhere/at/all")).toBeNull();
  });

  test("lists a page's route chunks and their imports, but not the entry's", () => {
    expect(hrefs("/browse/a/b%20c", ["/api/trpc/files.list?x"])).toEqual([
      "/api/trpc/files.list?x",
      "/assets/authed.js",
      "/assets/files-layout.js",
      "/assets/ui.js",
      "/assets/browse.js",
    ]);
    expect(hrefs("/")).toContain("/assets/root.js");
    expect(hrefs("/login")).toEqual(["/assets/login.js", "/assets/ui.js"]);
  });

  test("prefers a literal route over a splat and matches parameters", () => {
    expect(hrefs("/search")).toContain("/assets/search.js");
    expect(hrefs("/r/abc%2D_x")).toEqual(["/assets/request.js"]);
  });

  test("knows routes that only redirect, which have no code of their own in the build", () => {
    expect(preloads.match("/home")?.kind).toBe("files");
    expect(preloads.match("/start")?.kind).toBe("files");
  });

  test("names nothing for addresses outside the app", () => {
    expect(preloads.links("/nowhere/at/all", [])).toBe("");
  });
});
