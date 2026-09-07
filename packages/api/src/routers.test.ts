import { createTestDriveStore } from "./testing";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { appRouter } from "./routers";

const createCaller = () => {
  return appRouter.createCaller({
    headers: new Headers(),
    drive: createTestDriveStore().store,
    session: { user: { id: "user-1" } },
    preferences: {
      getUserPreferences: async () => null,
      setUserPreferences: async (_userId, prefs) => prefs,
    },
  });
};

describe("files.list", () => {
  let root: string;
  let previousRoot: string | undefined;

  beforeEach(async () => {
    previousRoot = process.env.NIMBUS_DATA_ROOT;
    root = await mkdtemp(path.join(os.tmpdir(), "nimbus-list-"));
    process.env.NIMBUS_DATA_ROOT = root;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    process.env.NIMBUS_DATA_ROOT = previousRoot;
  });

  it("rejects path traversal", async () => {
    const caller = createCaller();
    await expect(caller.files.list({ path: "../secret" })).rejects.toMatchObject(
      { code: "BAD_REQUEST" },
    );
  });

  it("returns NOT_FOUND for missing paths", async () => {
    const caller = createCaller();
    await expect(
      caller.files.list({ path: "missing-folder" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("filters .nimbus entries", async () => {
    const caller = createCaller();
    await mkdir(path.join(root, ".nimbus"));
    await writeFile(path.join(root, "visible.txt"), "hello");

    const entries = await caller.files.list({});
    const names = entries.map((entry) => entry.name);

    expect(names).toContain("visible.txt");
    expect(names).not.toContain(".nimbus");
  });
});
