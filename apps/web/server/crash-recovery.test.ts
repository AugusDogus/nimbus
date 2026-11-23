import {
  afterEach,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import {
  lstat,
  mkdtemp,
  readFile,
  rename,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { getAccess } from "@nimbus/api/access";
import type { DriveStore } from "@nimbus/api/drive-store";
import { restoreItem, trashItem } from "@nimbus/api/file-operations";
import { FileVersions } from "@nimbus/api/file-versions";
import { PendingChanges } from "@nimbus/api/pending-changes";
import { FileMutations, setScopeAuthority } from "@nimbus/api/file-mutations";
import { createPathLocks } from "@nimbus/api/path-locks";
import { openDatabase } from "./db/connection";
import { migrateDatabase } from "./db/migrate-database";
import { createDriveStore } from "./drive-store";

// Most tests here start a Bun process that migrates a database before it is killed, which can
// take longer than the default five seconds on a busy machine.
setDefaultTimeout(30_000);

/**
 * A process killed between a change's filesystem step and its database step, then started
 * again: startup recovery leaves every item with its own sharing and history.
 */
describe("changes interrupted by a crash", () => {
  let workspace: string;
  let root: string;
  let database: string;
  let previousRoot: string | undefined;
  beforeEach(async () => {
    previousRoot = process.env.NIMBUS_DATA_ROOT;
    workspace = await mkdtemp("/var/tmp/nimbus-crash-");
    root = path.join(workspace, "data");
    database = path.join(workspace, "db.sqlite");
    process.env.NIMBUS_DATA_ROOT = root;
    await Bun.write(path.join(root, "doc.txt"), "old");
    const opened = openDatabase(database);
    migrateDatabase(opened.sqlite);
    for (const id of ["owner", "carol"])
      opened.sqlite.run(
        "INSERT INTO user (id, name, email, role) VALUES (?, ?, ?, ?)",
        [id, id, `${id}@example.test`, id === "owner" ? "admin" : "user"],
      );
    opened.sqlite.close();
  });
  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
    if (previousRoot === undefined) delete process.env.NIMBUS_DATA_ROOT;
    else process.env.NIMBUS_DATA_ROOT = previousRoot;
  });

  /** Run `work` against the database, closing it before a crash or the next step. */
  async function withStore<T>(work: (store: DriveStore) => Promise<T>) {
    const opened = openDatabase(database);
    try {
      return await work(createDriveStore(opened.db));
    } finally {
      opened.sqlite.close();
    }
  }

  async function crashDuring(
    at: "trash" | "trashed" | "restore" | "move" | "version",
  ) {
    const child = Bun.spawn(
      ["bun", path.join(import.meta.dir, "crash-recovery.fixture.ts")],
      {
        env: {
          ...process.env,
          CRASH_DATABASE: database,
          NIMBUS_DATA_ROOT: root,
          CRASH_AT: at,
          NIMBUS_PROCESS_ID: deadServer,
        },
        stderr: "pipe",
      },
    );
    await child.exited;
    expect({
      signal: child.signalCode,
      output: await new Response(child.stderr).text(),
    }).toMatchObject({ signal: "SIGKILL" });
  }

  /** The server process the crash ends, as the supervisor names it. */
  const deadServer = "dead-server-0123456789";

  const shareWithCarol = () =>
    withStore((store) =>
      store.saveGrant({
        id: "carol-reads",
        path: "doc.txt",
        subject: { type: "user", id: "carol" },
        permission: "read",
      }),
    );

  test("moving to trash, killed after the trash record was written", async () => {
    await shareWithCarol();
    await crashDuring("trash");
    await withStore(async (store) => {
      const [recovered] = await PendingChanges.recover(store, root);
      expect(recovered?.outcome).toBe("undone");
      expect(await readFile(path.join(root, "doc.txt"), "utf8")).toBe("old");
      expect(await store.listTrash(null)).toEqual([]);
      expect((await getAccess(store, "carol")).can("doc.txt", "read")).toBe(
        true,
      );
    });
  });

  test("moving to trash, killed, then replaced by other content before the restart", async () => {
    await shareWithCarol();
    await crashDuring("trash");
    // While Nimbus was down, another program replaced the file with unrelated content.
    await rm(path.join(root, "doc.txt"));
    await writeFile(path.join(root, "doc.txt"), "someone else's");
    await withStore(async (store) => {
      const [recovered] = await PendingChanges.recover(store, root);
      expect(recovered?.outcome).toBe("unclear");
      expect((await getAccess(store, "carol")).can("doc.txt", "read")).toBe(
        false,
      );
    });
  });

  test("moving, killed, then the destination replaced before the restart", async () => {
    await shareWithCarol();
    await crashDuring("move");
    await rm(path.join(root, "moved.txt"));
    await writeFile(path.join(root, "moved.txt"), "someone else's");
    await withStore(async (store) => {
      const [recovered] = await PendingChanges.recover(store, root);
      expect(recovered?.outcome).toBe("unclear");
      expect((await getAccess(store, "carol")).can("moved.txt", "read")).toBe(
        false,
      );
    });
  });

  test("moved to trash, killed, then other content put in its trash place before the restart", async () => {
    await shareWithCarol();
    await crashDuring("trashed");
    await withStore(async (store) => {
      const [item] = await store.listTrash(null);
      if (!item) throw new Error("doc.txt did not reach trash.");
      const payload = path.join(root, ".nimbus/trash", item.id);
      await rm(payload);
      await writeFile(payload, "someone else's");
      const [recovered] = await PendingChanges.recover(store, root);
      expect(recovered?.outcome).toBe("unclear");
      // Restoring would give the other content doc.txt's sharing.
      await expect(
        restoreItem(store, await getAccess(store, "owner"), item.id),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      expect((await getAccess(store, "carol")).can("doc.txt", "read")).toBe(
        false,
      );
    });
  });

  /**
   * ext4 hands a freed inode number to the next file created, so content that replaced the item
   * can have its device and inode. This stat reports that for `replaced`, on any filesystem.
   */
  async function reusingInodeOf(original: string) {
    const item = await lstat(original, { bigint: true });
    return (replaced: string) => async (absolute: string) => {
      const found = await lstat(absolute, { bigint: true });
      return absolute === replaced
        ? { ...found, dev: item.dev, ino: item.ino }
        : found;
    };
  }

  test("content replacing a trashed item with its inode number is not taken for it", async () => {
    await shareWithCarol();
    const reusing = await reusingInodeOf(path.join(root, "doc.txt"));
    await crashDuring("trash");
    await rm(path.join(root, "doc.txt"));
    await writeFile(path.join(root, "doc.txt"), "someone else's");
    await withStore(async (store) => {
      const [recovered] = await PendingChanges.recover(
        store,
        root,
        reusing(path.join(root, "doc.txt")),
      );
      expect(recovered?.outcome).toBe("unclear");
      expect((await getAccess(store, "carol")).can("doc.txt", "read")).toBe(
        false,
      );
    });
  });

  test("content replacing a moved item with its inode number is not taken for it", async () => {
    await shareWithCarol();
    const reusing = await reusingInodeOf(path.join(root, "doc.txt"));
    await crashDuring("move");
    await rm(path.join(root, "moved.txt"));
    await writeFile(path.join(root, "moved.txt"), "someone else's");
    await withStore(async (store) => {
      const [recovered] = await PendingChanges.recover(
        store,
        root,
        reusing(path.join(root, "moved.txt")),
      );
      expect(recovered?.outcome).toBe("unclear");
      expect((await getAccess(store, "carol")).can("moved.txt", "read")).toBe(
        false,
      );
    });
  });

  test("content put in a trashed item's place with its inode number is not taken for it", async () => {
    await shareWithCarol();
    const reusing = await reusingInodeOf(path.join(root, "doc.txt"));
    await crashDuring("trashed");
    await withStore(async (store) => {
      const [item] = await store.listTrash(null);
      if (!item) throw new Error("doc.txt did not reach trash.");
      const payload = path.join(root, ".nimbus/trash", item.id);
      await rm(payload);
      await writeFile(payload, "someone else's");
      const [recovered] = await PendingChanges.recover(
        store,
        root,
        reusing(payload),
      );
      expect(recovered?.outcome).toBe("unclear");
      await expect(
        restoreItem(store, await getAccess(store, "owner"), item.id),
      ).rejects.toMatchObject({ code: "CONFLICT" });
    });
  });

  test("an item that only moved keeps being recognised, by inode and birth time", async () => {
    await shareWithCarol();
    await crashDuring("move");
    await withStore(async (store) => {
      const [recovered] = await PendingChanges.recover(store, root);
      expect(recovered?.outcome).toBe("finished");
    });
  });

  test("without birth times, as on some FUSE filesystems, modification times tell items apart", async () => {
    const withoutBirthTimes = async (absolute: string) => ({
      ...(await lstat(absolute, { bigint: true })),
      birthtimeNs: BigInt(0),
    });
    // A move whose rename happened before the crash: the item is recognised at its new path.
    const pendingMove = async (id: string) =>
      withStore(async (store) =>
        store.addPendingChange({
          id,
          identity: await PendingChanges.identityAt(
            path.join(root, "doc.txt"),
            withoutBirthTimes,
          ),
          kind: "move",
          from: "doc.txt",
          to: "moved.txt",
        }),
      );
    await pendingMove("first");
    await rename(path.join(root, "doc.txt"), path.join(root, "moved.txt"));
    await withStore(async (store) => {
      const [recovered] = await PendingChanges.recover(
        store,
        root,
        withoutBirthTimes,
      );
      expect(recovered?.outcome).toBe("finished");
    });
    // Content that replaced the item, given its inode number but written later, is not it.
    await rename(path.join(root, "moved.txt"), path.join(root, "doc.txt"));
    await pendingMove("second");
    const reusing = await reusingInodeOf(path.join(root, "doc.txt"));
    await rm(path.join(root, "doc.txt"));
    await writeFile(path.join(root, "moved.txt"), "someone else's");
    const later = new Date(Date.now() + 60_000);
    await utimes(path.join(root, "moved.txt"), later, later);
    const replacedStat = reusing(path.join(root, "moved.txt"));
    await withStore(async (store) => {
      const [recovered] = await PendingChanges.recover(
        store,
        root,
        async (absolute) => ({
          ...(await replacedStat(absolute)),
          birthtimeNs: BigInt(0),
        }),
      );
      expect(recovered?.outcome).toBe("unclear");
    });
  });

  test("restoring from trash, killed before sharing was reattached", async () => {
    await shareWithCarol();
    await withStore(async (store) =>
      trashItem(store, await getAccess(store, "owner"), "doc.txt"),
    );
    await crashDuring("restore");
    await withStore(async (store) => {
      const [recovered] = await PendingChanges.recover(store, root);
      expect(recovered?.outcome).toBe("finished");
      expect(await readFile(path.join(root, "doc.txt"), "utf8")).toBe("old");
      expect(await store.listTrash(null)).toEqual([]);
      expect((await getAccess(store, "carol")).can("doc.txt", "read")).toBe(
        true,
      );
    });
  });

  test("moving, killed before sharing followed the item", async () => {
    await shareWithCarol();
    await crashDuring("move");
    await withStore(async (store) => {
      const [recovered] = await PendingChanges.recover(store, root);
      expect(recovered?.outcome).toBe("finished");
      expect(await readFile(path.join(root, "moved.txt"), "utf8")).toBe("old");
      const carol = await getAccess(store, "carol");
      expect(carol.can("moved.txt", "read")).toBe(true);
      expect(carol.can("doc.txt", "read")).toBe(false);
      // Recovery ran once; running it again changes nothing.
      expect(await PendingChanges.recover(store, root)).toEqual([]);
    });
  });

  test("replacing a file, killed while its previous content was being kept", async () => {
    await writeFile(path.join(root, "doc.txt"), "old");
    await crashDuring("version");
    await withStore(async (store) => {
      expect(await PendingChanges.recover(store, root)).toEqual([]);
      const content = await readFile(path.join(root, "doc.txt"), "utf8");
      const kept = await Promise.all(
        (await FileVersions.history(store.versions, "doc.txt")).map(
          async (version) => {
            const found = await FileVersions.find(
              store.versions,
              "doc.txt",
              version.id,
            );
            return found ? readFile(found.payload(root), "utf8") : null;
          },
        ),
      );
      // Either the replacement never happened, or the old content is a version.
      expect({ content, kept }).toEqual(
        content === "old"
          ? { content: "old", kept: [] }
          : { content: "new", kept: ["old"] },
      );
    });
  });

  test("recovery for a dead server leaves another server's change in progress alone", async () => {
    await shareWithCarol();
    await crashDuring("trash");
    // Another server, still running, has recorded moving other.txt to trash and not yet renamed
    // it: what a crash would also leave.
    await Bun.write(path.join(root, "other.txt"), "in use");
    await withStore(async (store) => {
      const live = await PendingChanges.identityAt(
        path.join(root, "other.txt"),
      );
      await store.addTrash({
        id: "live-trash",
        path: "other.txt",
        deletedBy: "owner",
        deletedAt: 1,
        expiresAt: Date.now() + 60_000,
      });
      const opened = openDatabase(database);
      try {
        opened.sqlite.run(
          "INSERT INTO nimbus_pending_change (id, kind, trash_id, identity, created_at, owner) VALUES (?, 'trash', 'live-trash', ?, 1, 'live-server-0123456789')",
          [PendingChanges.trashMarker("live-trash"), live],
        );
      } finally {
        opened.sqlite.close();
      }
      const { recovered, failed } = await PendingChanges.recoverOwned(
        store,
        root,
        deadServer,
        [],
        () => undefined,
      );
      expect(failed).toEqual([]);
      expect(recovered.map((one) => one.outcome)).toEqual(["undone"]);
      expect((await getAccess(store, "carol")).can("doc.txt", "read")).toBe(
        true,
      );
      // The live server's trash record and its pending change are untouched.
      expect((await store.getTrash("live-trash"))?.path).toBe("other.txt");
      expect(
        (await store.listPendingChanges()).map((change) => change.owner),
      ).toEqual(["live-server-0123456789"]);
    });
  });

  test("a dead server's change waits for its paths unless a fence still holds them", async () => {
    await shareWithCarol();
    await crashDuring("trash");
    const scopes = createPathLocks();
    setScopeAuthority(scopes);
    try {
      // A live change holds doc.txt, as one could once the dead server's scopes were released.
      const release = await scopes.acquire([
        FileMutations.driveScope("doc.txt"),
      ]);
      const recovering = withStore((store) =>
        PendingChanges.recoverOwned(
          store,
          root,
          deadServer,
          [],
          () => undefined,
        ),
      );
      await Bun.sleep(50);
      // Nothing fenced it, so recovery waits for the path and re-reads the change after.
      expect(await readFile(path.join(root, "doc.txt"), "utf8")).toBe("old");
      release();
      expect((await recovering).recovered.map((one) => one.outcome)).toEqual([
        "undone",
      ]);
    } finally {
      setScopeAuthority(null);
    }
    // Fenced: the dead server's scopes are still held for it, so recovery acts without waiting.
    await crashDuring("trash");
    const fence = [
      FileMutations.driveScope(""),
      FileMutations.trashScope(""),
    ] as const;
    const fenced = createPathLocks();
    setScopeAuthority(fenced);
    try {
      await fenced.acquire(fence);
      const released: number[] = [];
      const { recovered } = await withStore((store) =>
        PendingChanges.recoverOwned(
          store,
          root,
          deadServer,
          [{ grant: 4, scopes: [...fence] }],
          (grant) => void released.push(grant),
        ),
      );
      expect(recovered.map((one) => one.outcome)).toEqual(["undone"]);
      expect(released).toEqual([4]);
    } finally {
      setScopeAuthority(null);
    }
  });

  test("a path recovery keeps failing on stays fenced; every other grant is released", async () => {
    await shareWithCarol();
    await crashDuring("trash");
    // A second change the dead server left, in another folder.
    await Bun.write(path.join(root, "other.txt"), "other");
    await withStore(async (store) => {
      const identity = await PendingChanges.identityAt(
        path.join(root, "other.txt"),
      );
      await store.addTrash({
        id: "other-trash",
        path: "other.txt",
        deletedBy: "owner",
        deletedAt: 1,
        expiresAt: Date.now() + 60_000,
      });
      const opened = openDatabase(database);
      try {
        opened.sqlite.run(
          "INSERT INTO nimbus_pending_change (id, kind, trash_id, identity, created_at, owner) VALUES (?, 'trash', 'other-trash', ?, 1, ?)",
          [PendingChanges.trashMarker("other-trash"), identity, deadServer],
        );
      } finally {
        opened.sqlite.close();
      }
      const released: number[] = [];
      const failing = path.join(root, "doc.txt");
      const { recovered, failed } = await PendingChanges.recoverOwned(
        store,
        root,
        deadServer,
        [
          {
            grant: 1,
            scopes: [
              FileMutations.driveScope("doc.txt"),
              FileMutations.trashScope(""),
            ],
          },
          {
            grant: 2,
            scopes: [
              FileMutations.driveScope("other.txt"),
              FileMutations.trashScope(""),
            ],
          },
        ],
        (grant) => void released.push(grant),
        async (absolute) => {
          if (absolute === failing)
            throw Object.assign(new Error("EIO: i/o error"), { code: "EIO" });
          return lstat(absolute, { bigint: true });
        },
      );
      expect(recovered.map((one) => one.change.id)).toEqual([
        PendingChanges.trashMarker("other-trash"),
      ]);
      expect(failed.map((one) => one.path)).toEqual(["doc.txt"]);
      expect(released).toEqual([2]);
    });
  });
});
