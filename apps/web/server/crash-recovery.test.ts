import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { getAccess } from "@nimbus/api/access";
import type { DriveStore } from "@nimbus/api/drive-store";
import { restoreItem, trashItem } from "@nimbus/api/file-operations";
import { FileVersions } from "@nimbus/api/file-versions";
import { PendingChanges } from "@nimbus/api/pending-changes";
import { openDatabase } from "./db/connection";
import { migrateDatabase } from "./db/migrate-database";
import { createDriveStore } from "./drive-store";

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
});
