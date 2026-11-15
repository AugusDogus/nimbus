import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DriveStore, TrashItem } from "@nimbus/api/drive-store";
import { createTestFileRequestStore } from "@nimbus/api/file-request-testing";
import { createTestFileVersionStore } from "@nimbus/api/file-versions-testing";
import { cleanExpiredData } from "./maintenance";

const day = 24 * 60 * 60 * 1000;
const now = Date.now();
let root: string;
let trash: TrashItem[];
const store: Pick<DriveStore, "listTrash" | "removeTrash" | "fileRequests" | "versions"> = {
  fileRequests: createTestFileRequestStore(),
  versions: createTestFileVersionStore(),
  async listTrash() {
    return trash;
  },
  async removeTrash(id) {
    trash = trash.filter((item) => item.id !== id);
  },
};

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "nimbus-retention-"));
  trash = [];
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function storedFile(relative: string, age: number) {
  const filename = path.join(root, ".nimbus", relative);
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, "test contents");
  await utimes(filename, new Date(now - age), new Date(now - age));
}

test("retention removes expired trash while retaining recoverable items", async () => {
  trash = [
    {
      id: "expired",
      path: "old.txt",
      deletedBy: "user",
      deletedAt: now - 31 * day,
      expiresAt: now - day,
    },
    {
      id: "retained",
      path: "recent.txt",
      deletedBy: "user",
      deletedAt: now - day,
      expiresAt: now + 29 * day,
    },
  ];
  await storedFile("trash/expired/child.txt", 31 * day);
  await storedFile("trash/retained", day);
  await cleanExpiredData(store, root, now);
  expect(trash.map((item) => item.id)).toEqual(["retained"]);
  expect(await readdir(path.join(root, ".nimbus/trash"))).toEqual(["retained"]);
});

test("retention preserves active upload metadata and ignores symbolic links", async () => {
  await storedFile("uploads/active", 0);
  await storedFile("uploads/active.json", 2 * day);
  await storedFile("uploads/active.done.tmp", 2 * day);
  await storedFile("uploads/expired", 2 * day);
  await storedFile("uploads/expired.json", 2 * day);
  await storedFile("uploads/expired.done", 2 * day);
  await storedFile("uploads/expired.done.tmp", 2 * day);
  await storedFile("cache/thumbnails/old.webp", 31 * day);
  await storedFile("cache/thumbnails/recent.webp", day);
  await symlink(
    path.join(root, ".nimbus/uploads/active"),
    path.join(root, ".nimbus/uploads/link"),
  );
  await cleanExpiredData(store, root, now);
  expect((await readdir(path.join(root, ".nimbus/uploads"))).sort()).toEqual([
    "active",
    "active.done.tmp",
    "active.json",
    "link",
  ]);
  expect(await readdir(path.join(root, ".nimbus/cache/thumbnails"))).toEqual([
    "recent.webp",
  ]);
});

test("retention cleans thumbnails in config while keeping uploads under data", async () => {
  const config = path.join(root, "config");
  const thumbnails = path.join(config, "cache/thumbnails");
  await mkdir(thumbnails, { recursive: true });
  const expired = path.join(thumbnails, "expired.webp");
  await writeFile(expired, "cached thumbnail");
  await utimes(expired, new Date(now - 31 * day), new Date(now - 31 * day));
  await writeFile(path.join(config, "db.sqlite"), "database");
  await storedFile("uploads/expired", 2 * day);
  await storedFile("uploads/recent", 0);
  await cleanExpiredData(store, root, now, config);
  expect(await readdir(thumbnails)).toEqual([]);
  expect(await readdir(path.join(root, ".nimbus/uploads"))).toEqual(["recent"]);
  expect(await readdir(config)).toContain("db.sqlite");
});
