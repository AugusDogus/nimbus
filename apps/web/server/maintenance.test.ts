import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type { DriveStore, TrashItem } from "@nimbus/api/drive-store";
import { createTestFileRequestStore } from "@nimbus/api/file-request-testing";
import { createTestFileVersionStore } from "@nimbus/api/file-versions-testing";
import { Staging } from "@nimbus/api/staging";
import { cleanExpiredData } from "./maintenance";
import { UploadLocks } from "./upload-locks";

const day = 24 * 60 * 60 * 1000;
const now = Date.now();
let root: string;
let trash: TrashItem[];
const prunedRevokedAt: number[] = [];
const store: Pick<
  DriveStore,
  | "listTrash"
  | "getTrash"
  | "removeTrash"
  | "removePendingChange"
  | "fileRequests"
  | "versions"
  | "pruneRevokedShares"
> = {
  fileRequests: createTestFileRequestStore(),
  versions: createTestFileVersionStore(),
  async pruneRevokedShares(at) {
    prunedRevokedAt.push(at);
  },
  async listTrash() {
    return trash;
  },
  async getTrash(id) {
    return trash.find((item) => item.id === id) ?? null;
  },
  async removeTrash(id) {
    trash = trash.filter((item) => item.id !== id);
  },
  async removePendingChange() {},
};

beforeEach(async () => {
  root = await mkdtemp("/var/tmp/nimbus-retention-");
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

test("retention waits for a request writing an upload, then keeps it if it was written meanwhile", async () => {
  const id = "0123456789abcdef0123456789abcdef";
  await storedFile(`uploads/${id}`, 2 * day);
  await storedFile(`uploads/${id}.json`, 2 * day);
  // A PATCH resumed just before retention runs holds the upload's lock while it writes.
  const { promise: written, resolve: write } = Promise.withResolvers<void>();
  const patch = UploadLocks.hold(id, async () => {
    await written;
    const touched = new Date();
    await utimes(path.join(root, ".nimbus/uploads", id), touched, touched);
  });
  const cleaning = cleanExpiredData(store, root, now);
  await Bun.sleep(50);
  write();
  await patch;
  await cleaning;
  expect((await readdir(path.join(root, ".nimbus/uploads"))).sort()).toEqual([
    id,
    `${id}.json`,
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

const asRoot = process.getuid?.() === 0;
const rootSkip = "running as root, where folder permissions do not apply";
if (asRoot)
  console.warn(`Skipping the undeletable trash retention test: ${rootSkip}.`);

test.skipIf(asRoot)(
  `retention goes on past an expired trash item it cannot delete, and reports it${asRoot ? ` (skipped: ${rootSkip})` : ""}`,
  async () => {
    const expired = (id: string): TrashItem => ({
      id,
      path: `${id}.txt`,
      deletedBy: "user",
      deletedAt: now - 31 * day,
      expiresAt: now - day,
    });
    trash = [expired("stuck"), expired("later")];
    // A trashed folder holding another user's read-only folder, which Nimbus cannot empty.
    await storedFile("trash/stuck/theirs/file.txt", 31 * day);
    const theirs = path.join(root, ".nimbus/trash/stuck/theirs");
    await chmod(theirs, 0o555);
    await storedFile("trash/later/file.txt", 31 * day);
    const config = path.join(root, "config");
    const thumbnails = path.join(config, "cache/thumbnails");
    await mkdir(thumbnails, { recursive: true });
    await writeFile(path.join(thumbnails, "expired.webp"), "cached");
    await utimes(
      path.join(thumbnails, "expired.webp"),
      new Date(now - 31 * day),
      new Date(now - 31 * day),
    );
    try {
      await expect(cleanExpiredData(store, root, now, config)).rejects.toThrow(
        "stuck",
      );
      expect(trash.map((item) => item.id)).toEqual(["stuck"]);
      expect(await readdir(path.join(root, ".nimbus/trash"))).toEqual([
        "stuck",
      ]);
      expect(await readdir(thumbnails)).toEqual([]);
    } finally {
      await chmod(theirs, 0o755);
    }
  },
);

test("retention removes abandoned copy staging folders but not one a copy is filling", async () => {
  const staging = path.join(root, ".nimbus/uploads");
  const old = new Date(now - 2 * day);
  for (const name of ["abandoned.copy", "filling.copy"]) {
    await mkdir(path.join(staging, name, "inner"), { recursive: true });
    await writeFile(path.join(staging, name, "inner/file.txt"), "copied");
    await utimes(path.join(staging, name), old, old);
  }
  const release = Staging.hold(path.join(staging, "filling.copy"));
  try {
    await cleanExpiredData(store, root, now, path.join(root, "config"));
  } finally {
    release();
  }
  expect(await readdir(staging)).toEqual(["filling.copy"]);
});

/**
 * Why btrfs subvolumes cannot be made where these tests keep their data roots, or null when
 * they can: that needs btrfs there and the btrfs tool.
 */
async function subvolumesUnavailable() {
  const probe = await mkdtemp("/var/tmp/nimbus-subvolume-probe-");
  try {
    const created = Bun.spawnSync(
      ["btrfs", "subvolume", "create", path.join(probe, "subvolume")],
      { stdout: "ignore", stderr: "pipe" },
    );
    return created.exitCode === 0
      ? null
      : `/var/tmp cannot hold a btrfs subvolume: ${created.stderr.toString().trim() || `btrfs exited with ${created.exitCode}`}`;
  } catch {
    return "the btrfs tool is not installed";
  } finally {
    await rm(probe, { recursive: true, force: true });
  }
}
const noSubvolumes = await subvolumesUnavailable();
if (noSubvolumes !== null)
  console.warn(`Skipping the btrfs subvolume staging test: ${noSubvolumes}.`);

test.skipIf(noSubvolumes !== null)(
  `retention cleans staging inside a btrfs subvolume that is not a mount point${noSubvolumes === null ? "" : ` (skipped: ${noSubvolumes})`}`,
  async () => {
    const subvolume = path.join(root, "subvolume");
    const created = Bun.spawnSync(["btrfs", "subvolume", "create", subvolume], {
      stdout: "ignore",
      stderr: "pipe",
    });
    expect(created.stderr.toString()).toBe("");
    try {
      const staging = await Staging.directoryFor(
        root,
        path.join(subvolume, "file.txt"),
      );
      expect(staging).toBe(path.join(subvolume, ".nimbus/uploads"));
      const abandoned = path.join(staging, "abandoned.staged");
      await writeFile(abandoned, "left by a crash");
      await utimes(abandoned, new Date(now - 2 * day), new Date(now - 2 * day));
      await cleanExpiredData(store, root, now, path.join(root, "config"));
      expect(await readdir(staging)).toEqual([]);
    } finally {
      await rm(path.join(subvolume, ".nimbus"), {
        recursive: true,
        force: true,
      });
    }
  },
);

test("retention prunes revoked-link records as of its own clock", async () => {
  trash = [];
  prunedRevokedAt.length = 0;
  await cleanExpiredData(store, root, now);
  expect(prunedRevokedAt).toEqual([now]);
});
