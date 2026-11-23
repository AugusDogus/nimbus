import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { StaticFiles, type StaticFile } from "./static-files";

const root = await mkdtemp(path.join(os.tmpdir(), "nimbus-static-"));
afterAll(() => rm(root, { recursive: true, force: true }));

describe("StaticFiles.load", () => {
  test("serves only the files the build listed", async () => {
    await mkdir(path.join(root, "assets"), { recursive: true });
    await mkdir(path.join(root, ".vite"), { recursive: true });
    await writeFile(path.join(root, "assets/app.js"), "console.log(1)");
    await writeFile(path.join(root, "icon.svg"), "<svg/>");
    // Placed in the build directory after the build, for example by a deployment.
    await writeFile(path.join(root, "assets/app.js.map"), "{}");
    await writeFile(path.join(root, ".env"), "SECRET=1");
    await writeFile(
      path.join(root, ".vite/files.json"),
      JSON.stringify(["assets/app.js", "icon.svg", "index.html"]),
    );
    const files = await StaticFiles.load(root, ["index.html"]);
    expect([...files.keys()].sort()).toEqual(["/assets/app.js", "/icon.svg"]);
  });

  test("refuses a build without its file list", async () => {
    const empty = await mkdtemp(path.join(os.tmpdir(), "nimbus-static-"));
    try {
      await writeFile(path.join(empty, "a.js"), "");
      await expect(StaticFiles.load(empty, [])).rejects.toThrow(
        "bun run build",
      );
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });
});

describe("StaticFiles.withEarlierAssets", () => {
  async function build(name: string, files: Record<string, string>) {
    const at = path.join(root, name);
    await mkdir(path.join(at, ".vite"), { recursive: true });
    for (const [file, body] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(at, file)), { recursive: true });
      await writeFile(path.join(at, file), body);
    }
    await writeFile(
      path.join(at, ".vite/files.json"),
      JSON.stringify(Object.keys(files)),
    );
    return at;
  }
  const text = (file: StaticFile | undefined) =>
    file ? new TextDecoder().decode(file.variants.identity.body) : null;

  test("adds the hashed assets an earlier build had, never replacing the current ones", async () => {
    const current = await StaticFiles.load(
      await build("current", {
        "assets/app-new.js": "new app",
        "assets/shared.js": "current shared",
        "icon.svg": "<svg>new</svg>",
      }),
      [],
    );
    const earlier = await build("earlier", {
      "assets/app-old.js": "old app",
      "assets/shared.js": "earlier shared",
      "icon.svg": "<svg>old</svg>",
      ".vite/manifest.json": JSON.stringify({
        "index.html": { file: "assets/app-old.js", imports: ["shared"] },
        shared: { file: "assets/shared.js" },
      }),
    });
    const { files, skipped } = await StaticFiles.withEarlierAssets(current, [
      earlier,
    ]);
    expect(skipped).toEqual([]);
    expect([...files.keys()].sort()).toEqual([
      "/assets/app-new.js",
      "/assets/app-old.js",
      "/assets/shared.js",
      "/icon.svg",
    ]);
    expect(text(files.get("/assets/app-old.js"))).toBe("old app");
    expect(text(files.get("/assets/shared.js"))).toBe("current shared");
    expect(text(files.get("/icon.svg"))).toBe("<svg>new</svg>");
    expect(files.get("/assets/app-old.js")?.immutable).toBe(true);
  });

  test("keeps only what the earlier build's manifest lists as its hashed output", async () => {
    const current = await StaticFiles.load(
      await build("current-2", { "assets/app-new.js": "new app" }),
      [],
    );
    const earlier = await build("earlier-2", {
      "assets/app-old.js": "old app",
      "assets/app-old.css": "old styles",
      "assets/font-old.woff2": "old font",
      // Listed for serving by the build, but no hashed output: a page never asks for it by hash.
      "assets/notes.txt": "dropped",
      ".vite/manifest.json": JSON.stringify({
        "index.html": {
          file: "assets/app-old.js",
          css: ["assets/app-old.css"],
          assets: ["assets/font-old.woff2"],
          isEntry: true,
        },
      }),
    });
    const { files } = await StaticFiles.withEarlierAssets(current, [earlier]);
    expect([...files.keys()].sort()).toEqual([
      "/assets/app-new.js",
      "/assets/app-old.css",
      "/assets/app-old.js",
      "/assets/font-old.woff2",
    ]);
  });

  test("skips an earlier build that is gone, saying why", async () => {
    const current = await StaticFiles.load(
      await build("alone", { "assets/app.js": "app" }),
      [],
    );
    const gone = path.join(root, "removed-release");
    const { files, skipped } = await StaticFiles.withEarlierAssets(current, [
      gone,
    ]);
    expect([...files.keys()]).toEqual(["/assets/app.js"]);
    expect(skipped.map((entry) => entry.root)).toEqual([gone]);
  });
});
