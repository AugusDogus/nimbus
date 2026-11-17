import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getAccess } from "@nimbus/api/access";
import type { Grant, Permission } from "@nimbus/api/drive-store";
import { forgetFileMutationsForTest } from "@nimbus/api/file-mutations";
import { appRouter } from "@nimbus/api/routers";
import { createTestDatabase } from "./db/testing";
import { createDriveStore } from "./drive-store";

/** Accounts every test drive has: one server administrator and three people. */
const accounts = [
  { id: "owner", role: "admin" },
  { id: "alice", role: "user" },
  { id: "bob", role: "user" },
  { id: "carol", role: "user" },
] as const;
export type TestAccount = (typeof accounts)[number]["id"];

/**
 * A drive backed by the real SQLite store, migrated with its access-epoch triggers, and a
 * fresh data root under /var/tmp. Unlike the in-memory store, cached access here is reused
 * until a trigger changes the epoch, so tests see stale permissions the way the server would.
 * Call `close` when done; it restores the previous data root.
 */
export async function openTestDrive() {
  const opened = createTestDatabase();
  for (const account of accounts)
    opened.sqlite.run(
      "INSERT INTO user (id, name, email, role) VALUES (?, ?, ?, ?)",
      [account.id, account.id, `${account.id}@example.test`, account.role],
    );
  const store = createDriveStore(opened.db);
  const previousRoot = process.env.NIMBUS_DATA_ROOT;
  const root = await mkdtemp("/var/tmp/nimbus-test-drive-");
  process.env.NIMBUS_DATA_ROOT = root;
  return {
    store,
    sqlite: opened.sqlite,
    root,
    absolute: (relative: string) => path.join(root, relative),
    caller: (id: TestAccount) =>
      appRouter.createCaller({
        headers: new Headers(),
        session: { user: { id } },
        drive: store,
        preferences: {
          getUserPreferences: async () => null,
          setUserPreferences: async (_id, value) => value,
        },
      }),
    access: (id: TestAccount) => getAccess(store, id),
    async write(relative: string, content = relative) {
      await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
      await writeFile(path.join(root, relative), content);
    },
    async grant(
      relative: string,
      id: TestAccount,
      permission: Permission,
    ): Promise<Grant> {
      const grant: Grant = {
        id: randomUUID(),
        path: relative,
        subject: { type: "user", id },
        permission,
      };
      await store.saveGrant(grant);
      return grant;
    },
    async share(relative: string) {
      const id = randomUUID();
      await store.createShare({
        id,
        token: id,
        path: relative,
        createdBy: "owner",
        createdAt: Date.now(),
        expiresAt: null,
        passwordHash: null,
        downloadCount: 0,
        maxDownloads: null,
        mode: "download",
      });
      return id;
    },
    async close() {
      forgetFileMutationsForTest(root);
      opened.sqlite.close();
      await rm(root, { recursive: true, force: true });
      if (previousRoot === undefined) delete process.env.NIMBUS_DATA_ROOT;
      else process.env.NIMBUS_DATA_ROOT = previousRoot;
    },
  };
}
export type TestDrive = Awaited<ReturnType<typeof openTestDrive>>;
