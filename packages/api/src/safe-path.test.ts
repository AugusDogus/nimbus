import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { resolveSafePath } from "./safe-path";

describe("storage boundaries", () => {
  let directory: string;
  let previousRoot: string | undefined;

  beforeEach(async () => {
    previousRoot = process.env.NIMBUS_DATA_ROOT;
    directory = await mkdtemp(path.join(os.tmpdir(), "nimbus-path-"));
    process.env.NIMBUS_DATA_ROOT = path.join(directory, "data");
    await mkdir(path.join(directory, "data"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
    if (previousRoot === undefined) delete process.env.NIMBUS_DATA_ROOT;
    else process.env.NIMBUS_DATA_ROOT = previousRoot;
  });

  it("rejects traversal and internal storage", async () => {
    for (const requested of [
      "../secret",
      "/etc/passwd",
      ".nimbus/db.sqlite",
      "folder/../.nimbus/db.sqlite",
    ]) {
      await expect(
        Promise.resolve().then(() => resolveSafePath(requested)),
      ).rejects.toBeDefined();
    }
  });

  it("rejects symlinks, including missing destinations under a linked directory", async () => {
    await mkdir(path.join(directory, "outside"));
    await symlink(
      path.join(directory, "outside"),
      path.join(directory, "data", "link"),
    );
    await expect(
      Promise.resolve().then(() => resolveSafePath("link/new.txt")),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("preserves literal percent-encoded names and dot-prefixed names", async () => {
    await writeFile(path.join(directory, "data", "%41.txt"), "literal");
    expect((await resolveSafePath("%41.txt")).relative).toBe("%41.txt");
    expect((await resolveSafePath("..notes")).relative).toBe("..notes");
  });
});
