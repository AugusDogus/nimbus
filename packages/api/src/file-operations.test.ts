import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getAccess } from "./access";
import { copyItem, moveItem } from "./file-operations";
import { createTestDriveStore } from "./testing";

describe("moving and copying onto existing destinations", () => {
  let root: string;
  let previousRoot: string | undefined;
  let memory: ReturnType<typeof createTestDriveStore>;
  const owner = () => getAccess(memory.store, "user-1");
  const read = (relative: string) => readFile(path.join(root, relative), "utf8");
  const share = (id: string, sharedPath: string) =>
    memory.store.createShare({ id, token: id, path: sharedPath, createdBy: "user-1", createdAt: 1, expiresAt: null, passwordHash: null, downloadCount: 0, maxDownloads: null, mode: "download" });

  beforeEach(async () => {
    previousRoot = process.env.NIMBUS_DATA_ROOT;
    root = await mkdtemp(path.join(os.tmpdir(), "nimbus-transfer-"));
    process.env.NIMBUS_DATA_ROOT = root;
    memory = createTestDriveStore();
    await mkdir(path.join(root, "docs/sub"), { recursive: true });
    await writeFile(path.join(root, "docs/report.txt"), "original");
    await writeFile(path.join(root, "docs/sub/nested.txt"), "nested");
    await writeFile(path.join(root, "draft.tmp"), "edited");
  });
  afterEach(async () => {
    globalThis.nimbusFileMutations?.delete(root);
    await rm(root, { recursive: true, force: true });
    if (previousRoot === undefined) delete process.env.NIMBUS_DATA_ROOT;
    else process.env.NIMBUS_DATA_ROOT = previousRoot;
  });

  it("refuses an existing destination unless replacement is requested", async () => {
    await expect(moveItem(memory.store, await owner(), "draft.tmp", "docs/report.txt")).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(copyItem(memory.store, await owner(), "draft.tmp", "docs/report.txt")).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await read("docs/report.txt")).toBe("original");
  });

  it("replaces a file's content in place, keeping the destination's links like a save", async () => {
    await share("kept", "docs/report.txt");
    await share("temporary", "draft.tmp");
    const result = await moveItem(memory.store, await owner(), "draft.tmp", "docs/report.txt", { existing: "replace" });
    expect(result).toMatchObject({ path: "docs/report.txt", replaced: true });
    expect(await read("docs/report.txt")).toBe("edited");
    expect(await readdir(root)).not.toContain("draft.tmp");
    expect((await memory.store.getShare("kept"))?.path).toBe("docs/report.txt");
    expect(await memory.store.getShare("temporary")).toBeNull();
    expect(await memory.store.listTrash(null)).toEqual([]);
  });

  it("sends a replaced folder to trash so it can be recovered", async () => {
    await share("folder", "docs");
    await mkdir(path.join(root, "incoming"));
    await writeFile(path.join(root, "incoming/new.txt"), "new");
    await moveItem(memory.store, await owner(), "incoming", "docs", { existing: "replace" });
    expect(await readdir(path.join(root, "docs"))).toEqual(["new.txt"]);
    const [trashed] = await memory.store.listTrash(null);
    expect(trashed?.path).toBe("docs");
    expect(await memory.store.getShare("folder")).toBeNull();
  });

  it("never replaces an item with one of its own descendants", async () => {
    await expect(moveItem(memory.store, await owner(), "docs/sub", "docs", { existing: "replace" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(copyItem(memory.store, await owner(), "docs/sub/nested.txt", "docs", { existing: "replace" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await read("docs/sub/nested.txt")).toBe("nested");
  });

  it("copies folders deeply or shallowly without carrying links", async () => {
    await share("source", "docs");
    await copyItem(memory.store, await owner(), "docs", "deep");
    expect(await read("deep/sub/nested.txt")).toBe("nested");
    await copyItem(memory.store, await owner(), "docs", "shallow", { depth: "0" });
    expect(await readdir(path.join(root, "shallow"))).toEqual([]);
    expect((await memory.store.listShares("user-1")).map((entry) => entry.path)).toEqual(["docs"]);
    expect(await readdir(path.join(root, ".nimbus/uploads"))).toEqual([]);
  });

  it("replaces a file by copy and reports whether the destination existed", async () => {
    expect(await copyItem(memory.store, await owner(), "draft.tmp", "copy.txt")).toMatchObject({ replaced: false });
    expect(await copyItem(memory.store, await owner(), "docs/report.txt", "copy.txt", { existing: "replace" })).toMatchObject({ replaced: true });
    expect(await read("copy.txt")).toBe("original");
  });
});
