import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { statPath } from "./fs-utils";

describe("statPath", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "nimbus-fs-utils-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("returns correct summary for files and directories", async () => {
    const filePath = path.join(root, "alpha.txt");
    await writeFile(filePath, "hello");

    const dirStats = await statPath(root);
    expect(dirStats.isDirectory).toBe(true);
    expect(dirStats.isFile).toBe(false);
    expect(dirStats.mtimeMs).toBeGreaterThan(0);

    const fileStats = await statPath(filePath);
    expect(fileStats.isFile).toBe(true);
    expect(fileStats.isDirectory).toBe(false);
    expect(fileStats.size).toBe(5);
    expect(fileStats.mtimeMs).toBeGreaterThan(0);
  });
});
