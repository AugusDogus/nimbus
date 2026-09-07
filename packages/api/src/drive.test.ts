import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { appRouter } from "./routers";
import { createTestDriveStore } from "./testing";
import { resetListCacheForTest } from "./list-cache";
import { resetDirListCacheForTest } from "./dir-list-cache";

describe("drive workflows", () => {
  let root: string;
  let previousRoot: string | undefined;
  let memory: ReturnType<typeof createTestDriveStore>;
  const caller = (id = "user-1") => appRouter.createCaller({ headers: new Headers(), session: { user: { id } }, drive: memory.store, preferences: { getUserPreferences: async () => null, setUserPreferences: async (_id, value) => value } });
  beforeEach(async () => {
    previousRoot = process.env.NIMBUS_DATA_ROOT;
    root = await mkdtemp(path.join(os.tmpdir(), "nimbus-drive-"));
    process.env.NIMBUS_DATA_ROOT = root;
    memory = createTestDriveStore();
    resetListCacheForTest(); resetDirListCacheForTest();
    await mkdir(path.join(root, "docs"));
    await writeFile(path.join(root, "docs", "report.txt"), "report");
    await writeFile(path.join(root, "private.txt"), "private");
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    if (previousRoot === undefined) delete process.env.NIMBUS_DATA_ROOT; else process.env.NIMBUS_DATA_ROOT = previousRoot;
  });
  it("prevents all mutations of the drive root", async () => {
    await expect(caller().files.delete({ path: "" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(caller().files.rename({ path: ".", newName: "renamed" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(caller().files.move({ sourcePath: "", destinationPath: "docs" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect((await stat(root)).isDirectory()).toBe(true);
  });
  it("rejects reserved, blank, and traversal filenames", async () => {
    for (const name of [" ", ".nimbus", "../escape", "folder/file", "bad\0name"]) await expect(caller().files.createFolder({ name })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
  it("grants folder access without exposing siblings, and revokes cached access immediately", async () => {
    await caller().access.grant({ path: "docs", subject: { type: "user", id: "reader" }, permission: "read" });
    expect((await caller("reader").files.list({})).map((entry) => entry.name)).toEqual(["docs"]);
    expect((await caller("reader").files.list({ path: "docs" }))[0]?.name).toBe("report.txt");
    await expect(caller("reader").files.delete({ path: "docs/report.txt" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const [grant] = await caller().access.permissions({ path: "docs" });
    if (!grant) throw new Error("Expected a grant");
    await caller().access.revoke({ path: "docs", id: grant.id });
    await expect(caller("reader").files.list({ path: "docs" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("resolves group permissions and removes access with membership", async () => {
    await caller().access.saveGroup({ name: "Team", memberIds: ["reader"] });
    const [group] = await caller().access.groups();
    if (!group) throw new Error("Expected a group");
    await caller().access.grant({ path: "docs", subject: { type: "group", id: group.id }, permission: "write" });
    await caller("reader").files.createFolder({ path: "docs", name: "notes" });
    await caller().access.saveGroup({ ...group, memberIds: [] });
    await expect(caller("reader").files.createFolder({ path: "docs", name: "private" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("trashes and restores content without overwriting existing files", async () => {
    await caller().files.delete({ path: "docs/report.txt" });
    const [item] = await caller().trash.list();
    if (!item) throw new Error("Expected a trash item");
    await writeFile(path.join(root, "docs/report.txt"), "replacement");
    await expect(caller().trash.restore({ id: item.id })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await readFile(path.join(root, "docs/report.txt"), "utf8")).toBe("replacement");
    await rm(path.join(root, "docs/report.txt"));
    await caller().trash.restore({ id: item.id });
    expect(await readFile(path.join(root, "docs/report.txt"), "utf8")).toBe("report");
    expect(await caller().trash.list()).toEqual([]);
  });
  it("revokes share links when a file is moved and preserves unrelated links", async () => {
    const moved = await caller().shares.create({ path: "docs/report.txt", expiresAt: null, password: "test-password" });
    const kept = await caller().shares.create({ path: "private.txt", expiresAt: null });
    await caller().files.rename({ path: "docs/report.txt", newName: "renamed.txt" });
    expect(await memory.store.getShare(moved.token)).toBeNull();
    expect(await memory.store.getShare(kept.token)).not.toBeNull();
  });
  it("searches only accessible files and keeps password hashes out of API responses", async () => {
    await caller().access.grant({ path: "docs", subject: { type: "user", id: "reader" }, permission: "read" });
    expect((await caller("reader").catalog.search({ query: ".txt", path: "" })).entries.map((entry) => entry.name)).toEqual(["report.txt"]);
    await caller().shares.create({ path: "docs", expiresAt: null, password: "test-password" });
    expect(await caller().shares.list()).toMatchObject([{ passwordProtected: true }]);
    expect(JSON.stringify(await caller().shares.list())).not.toContain("passwordHash");
    await expect(caller("reader").shares.create({ path: "docs", expiresAt: null })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
