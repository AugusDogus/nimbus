import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { appRouter } from "./routers";
import { createSearchIndex } from "./search-index";
import { provideSearchService } from "./search-service";
import { crawlingSearchService, createTestDriveStore } from "./testing";

describe("searching for folders only", () => {
  for (const compacted of [false, true])
    it(`ranks and limits folders among themselves${compacted ? " once compacted" : ""}`, () => {
      const index = createSearchIndex(4);
      // Files that would fill every place of a small page, ahead of the folders.
      for (let file = 0; file < 200; file++)
        index.add(`notes/project-${file}.txt`, "file");
      for (const folder of ["Project Alpha", "Project Beta", "old/project"])
        index.add(`work/${folder}`, "dir");
      if (compacted) index.compact();
      const found = index.search({
        query: "project",
        root: "",
        limit: 2,
        scope: { type: "all" },
        depth: "full",
        only: "folders",
      });
      expect(found.hits.every((hit) => hit.type === "dir")).toBe(true);
      expect(found.hits).toHaveLength(2);
      expect(found.total).toBe(3);
      expect(found.truncated).toBe(true);
    });
});

describe("catalog.destinations", () => {
  let root: string;
  let previousRoot: string | undefined;
  let memory: ReturnType<typeof createTestDriveStore>;
  const caller = (id: string) =>
    appRouter.createCaller({
      headers: new Headers(),
      session: { user: { id } },
      sessionStillValid: async () => true,
      drive: memory.store,
      preferences: {
        getUserPreferences: async () => null,
        setUserPreferences: async (_id, value) => value,
      },
    });

  beforeEach(async () => {
    previousRoot = process.env.NIMBUS_DATA_ROOT;
    root = await mkdtemp(path.join(os.tmpdir(), "nimbus-destinations-"));
    process.env.NIMBUS_DATA_ROOT = root;
    provideSearchService(crawlingSearchService(root));
    memory = createTestDriveStore();
    for (const folder of [
      "readable/Target",
      "writable/Target",
      "hidden/Target",
    ])
      await mkdir(path.join(root, folder), { recursive: true });
    for (let file = 0; file < 60; file++)
      await writeFile(path.join(root, `writable/Target file ${file}.txt`), "");
    memory.grants.set("read", {
      id: "read",
      subject: { type: "user", id: "reader" },
      path: "readable",
      permission: "read",
    });
    memory.grants.set("write", {
      id: "write",
      subject: { type: "user", id: "reader" },
      path: "writable",
      permission: "write",
    });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    if (previousRoot === undefined) delete process.env.NIMBUS_DATA_ROOT;
    else process.env.NIMBUS_DATA_ROOT = previousRoot;
  });

  it("finds only folders the account can write to, before the limit", async () => {
    const found = await caller("reader").catalog.destinations({
      query: "target",
      limit: 1,
    });
    expect(found.entries).toEqual([
      {
        name: "Target",
        path: "writable/Target",
        permission: "write",
        fixed: false,
      },
    ]);
    expect(found.truncated).toBe(false);
  });

  it("finds every matching folder for an administrator", async () => {
    const found = await caller("user-1").catalog.destinations({
      query: "target",
    });
    expect(found.entries.map((entry) => entry.path).sort()).toEqual([
      "hidden/Target",
      "readable/Target",
      "writable/Target",
    ]);
  });

  it("states a folder's own permission, and refuses folders the account cannot see", async () => {
    const reader = caller("reader");
    expect(await reader.files.destination({ path: "writable" })).toEqual({
      path: "writable",
      permission: "write",
    });
    expect(await reader.files.destination({ path: "readable/Target" })).toEqual(
      { path: "readable/Target", permission: "read" },
    );
    // The top folder is browsable by everyone, and writable only through a grant on it.
    expect(await reader.files.destination({ path: "" })).toEqual({
      path: "",
      permission: "read",
    });
    await expect(
      reader.files.destination({ path: "hidden" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      reader.files.destination({ path: "writable/missing" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
