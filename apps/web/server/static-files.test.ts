import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { StaticFiles } from "./static-files";

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
