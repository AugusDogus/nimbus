import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getAccess } from "./access";
import { mutateFiles } from "./file-mutations";
import { moveItem, purgeItem, restoreItem, trashItem } from "./file-operations";
import { createTestDriveStore } from "./testing";

let root: string;
let previousRoot: string | undefined;
let memory: ReturnType<typeof createTestDriveStore>;

beforeEach(async () => {
  previousRoot = process.env.NIMBUS_DATA_ROOT;
  root = await mkdtemp(path.join(os.tmpdir(), "nimbus-scopes-"));
  process.env.NIMBUS_DATA_ROOT = root;
  memory = createTestDriveStore();
  await mkdir(path.join(root, "old"));
  await writeFile(path.join(root, "old/a.txt"), "a");
  await mkdir(path.join(root, "docs"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  if (previousRoot === undefined) delete process.env.NIMBUS_DATA_ROOT;
  else process.env.NIMBUS_DATA_ROOT = previousRoot;
});

/** A store whose history removal waits until `finish` is called, like a long purge. */
function slowPurges() {
  let finish = () => {};
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const removeAt = memory.store.versions.removeAt;
  const store = {
    ...memory.store,
    versions: {
      ...memory.store.versions,
      removeAt: async (location: string) => {
        await gate;
        return removeAt(location);
      },
    },
  };
  return { store, finish };
}

test("a long purge holds only its trash item: other changes proceed, its restore waits", async () => {
  const owner = await getAccess(memory.store, "user-1");
  const { trashId } = await trashItem(memory.store, owner, "old");
  const { store, finish } = slowPurges();
  const events: string[] = [];
  const purge = purgeItem(store, owner, trashId).then(() =>
    events.push("purged"),
  );
  const restore = restoreItem(memory.store, owner, trashId).then(
    () => events.push("restored"),
    (error: unknown) =>
      events.push(
        `restore ${error instanceof Error && "code" in error ? String(error.code) : "failed"}`,
      ),
  );
  // Unrelated work, including trashing something else, finishes during the purge.
  await moveItem(memory.store, owner, "docs", "papers");
  await writeFile(path.join(root, "b.txt"), "b");
  await trashItem(memory.store, owner, "b.txt");
  events.push("unrelated done");
  finish();
  await Promise.all([purge, restore]);
  expect(events).toEqual(["unrelated done", "purged", "restore NOT_FOUND"]);
  expect(await readdir(root)).not.toContain("old");
  expect((await stat(path.join(root, "papers"))).isDirectory()).toBe(true);
});

test("overlapping changes run one at a time in arrival order", async () => {
  const order: string[] = [];
  let finish = () => {};
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const credentials = { userId: "user-1" };
  const outer = mutateFiles(["docs"], credentials, async () => {
    await gate;
    order.push("folder");
  });
  const inner = mutateFiles(["docs/a.txt"], credentials, async () => {
    order.push("file in folder");
  });
  const elsewhere = mutateFiles(["photos/b.jpg"], credentials, async () => {
    order.push("elsewhere");
  });
  await elsewhere;
  expect(order).toEqual(["elsewhere"]);
  finish();
  await Promise.all([outer, inner]);
  expect(order).toEqual(["elsewhere", "folder", "file in folder"]);
});

test("a mutation without a scope is refused", async () => {
  let ran = false;
  await expect(
    mutateFiles([], { userId: "user-1" }, async () => {
      ran = true;
    }),
  ).rejects.toThrow("without a scope");
  expect(ran).toBe(false);
});
