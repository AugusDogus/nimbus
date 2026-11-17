import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getAccess } from "@nimbus/api/access";
import type { Share } from "@nimbus/api/drive-store";
import { createTestDriveStore } from "@nimbus/api/testing";
import { sharedTarget } from "./public-share";

let root: string;
let previousRoot: string | undefined;
beforeEach(async () => {
  previousRoot = process.env.NIMBUS_DATA_ROOT;
  root = await mkdtemp(path.join(os.tmpdir(), "nimbus-public-share-"));
  process.env.NIMBUS_DATA_ROOT = root;
  await mkdir(path.join(root, "docs"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  if (previousRoot === undefined) delete process.env.NIMBUS_DATA_ROOT;
  else process.env.NIMBUS_DATA_ROOT = previousRoot;
});

const share: Share = {
  id: "share",
  token: "token",
  path: "docs",
  createdBy: "user-1",
  createdAt: 0,
  expiresAt: null,
  passwordHash: null,
  downloadCount: 0,
  maxDownloads: null,
  mode: "download",
};

test("a link's access reads inside its path and carries none of its creator's other rights", async () => {
  const creator = await getAccess(createTestDriveStore().store, "user-1");
  expect(creator.isAdmin).toBe(true);
  const { access } = await sharedTarget(share, creator, "");
  expect(access.isAdmin).toBe(false);
  expect(access.grants).toEqual([]);
  expect(() => access.requireAdmin()).toThrow();
  expect(access.can("docs/a.txt", "read")).toBe(true);
  expect(access.can("docs/a.txt", "write")).toBe(false);
  expect(access.can("other.txt", "read")).toBe(false);
});
