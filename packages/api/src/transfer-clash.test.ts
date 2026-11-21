import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { forgetFileMutationsForTest } from "./file-mutations";
import { appRouter } from "./routers";
import { createTestDriveStore } from "./testing";

describe("name clashes when moving and copying", () => {
  let root: string;
  let previousRoot: string | undefined;
  const caller = () =>
    appRouter.createCaller({
      headers: new Headers(),
      session: { user: { id: "user-1" } },
      sessionStillValid: async () => true,
      drive: createTestDriveStore().store,
      preferences: {
        getUserPreferences: async () => null,
        setUserPreferences: async (_id, value) => value,
      },
    });
  const read = (relative: string) =>
    readFile(path.join(root, relative), "utf8");

  beforeEach(async () => {
    previousRoot = process.env.NIMBUS_DATA_ROOT;
    root = await mkdtemp(path.join(os.tmpdir(), "nimbus-clash-"));
    process.env.NIMBUS_DATA_ROOT = root;
    await mkdir(path.join(root, "docs"));
    await mkdir(path.join(root, "archive/report.txt (folder)"), {
      recursive: true,
    });
    await writeFile(path.join(root, "docs/report.txt"), "mine");
    await writeFile(path.join(root, "archive/report.txt"), "theirs");
  });
  afterEach(async () => {
    forgetFileMutationsForTest(root);
    await rm(root, { recursive: true, force: true });
    if (previousRoot === undefined) delete process.env.NIMBUS_DATA_ROOT;
    else process.env.NIMBUS_DATA_ROOT = previousRoot;
  });

  it("report a taken name on a move and change nothing", async () => {
    expect(
      await caller().files.move({
        sourcePath: "docs/report.txt",
        destinationPath: "archive",
      }),
    ).toEqual({
      kind: "clash",
      name: "report.txt",
      suggestion: "report (1).txt",
    });
    expect(await read("docs/report.txt")).toBe("mine");
    expect(await read("archive/report.txt")).toBe("theirs");
  });

  it("keep both on request, under the first free numbered name", async () => {
    await writeFile(path.join(root, "archive/report (1).txt"), "older");
    expect(
      await caller().files.move({
        sourcePath: "docs/report.txt",
        destinationPath: "archive",
        clash: "keep-both",
      }),
    ).toMatchObject({ kind: "transferred", path: "archive/report (2).txt" });
    expect(await read("archive/report.txt")).toBe("theirs");
    expect(await read("archive/report (1).txt")).toBe("older");
  });

  it("move under a name of the person's choosing, and report that name taken too", async () => {
    expect(
      await caller().files.move({
        sourcePath: "docs/report.txt",
        destinationPath: "archive",
        name: "report (1).txt",
      }),
    ).toMatchObject({ kind: "transferred", name: "report (1).txt" });
    await writeFile(path.join(root, "docs/report.txt"), "again");
    expect(
      await caller().files.move({
        sourcePath: "docs/report.txt",
        destinationPath: "archive",
        name: "report (1).txt",
      }),
    ).toEqual({
      kind: "clash",
      name: "report (1).txt",
      suggestion: "report (2).txt",
    });
    await expect(
      caller().files.move({
        sourcePath: "docs/report.txt",
        destinationPath: "archive",
        name: "../escape.txt",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("keep both by default on a copy, and report the name only when asked to refuse", async () => {
    expect(
      await caller().files.copy({
        sourcePath: "docs/report.txt",
        destinationPath: "archive",
      }),
    ).toMatchObject({ kind: "transferred", name: "report (1).txt" });
    expect(
      await caller().files.copy({
        sourcePath: "docs/report.txt",
        destinationPath: "archive",
        clash: "refuse",
      }),
    ).toEqual({
      kind: "clash",
      name: "report.txt",
      // "report (1).txt" is the copy made just before.
      suggestion: "report (2).txt",
    });
    expect(
      await caller().files.copy({
        sourcePath: "docs/report.txt",
        destinationPath: "docs",
        clash: "refuse",
      }),
    ).toEqual({
      kind: "clash",
      name: "report.txt",
      suggestion: "report (1).txt",
    });
    expect(await read("archive/report.txt")).toBe("theirs");
  });

  it("refuse a move into the folder the item is already in", async () => {
    await expect(
      caller().files.move({
        sourcePath: "docs/report.txt",
        destinationPath: "docs",
        clash: "keep-both",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await read("docs/report.txt")).toBe("mine");
  });

  it("number names at the 255-byte limit within it, on a move clash and a copy", async () => {
    const long = `${"n".repeat(251)}.txt`;
    await writeFile(path.join(root, "docs", long), "mine");
    await writeFile(path.join(root, "archive", long), "theirs");
    const clash = await caller().files.move({
      sourcePath: `docs/${long}`,
      destinationPath: "archive",
    });
    if (clash.kind !== "clash") throw new Error("Expected a clash.");
    expect(Buffer.byteLength(clash.suggestion)).toBeLessThanOrEqual(255);
    expect(clash.suggestion.endsWith(" (1).txt")).toBe(true);
    const kept = await caller().files.move({
      sourcePath: `docs/${long}`,
      destinationPath: "archive",
      clash: "keep-both",
    });
    expect(kept).toMatchObject({ kind: "transferred", name: clash.suggestion });
    const copied = await caller().files.copy({
      sourcePath: `archive/${long}`,
      destinationPath: "archive",
    });
    expect(copied).toMatchObject({ kind: "transferred" });
    expect(await read(`archive/${long}`)).toBe("theirs");
  });
});
