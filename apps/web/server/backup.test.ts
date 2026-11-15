import { afterEach, beforeEach, expect, test } from "bun:test";
import { createClient } from "@libsql/client";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Backup } from "./backup";

let root: string;
let databaseUrl: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "nimbus-backup-"));
  databaseUrl = `file:${path.join(root, "db.sqlite")}`;
  const client = createClient({ url: databaseUrl });
  await client.execute("PRAGMA journal_mode = WAL");
  await client.execute("CREATE TABLE item (id INTEGER PRIMARY KEY, body TEXT NOT NULL)");
  await client.execute("INSERT INTO item (body) VALUES ('committed before the backup')");
  client.close();
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test("a backup is a consistent private snapshot and old backups are pruned", async () => {
  const directory = path.join(root, "backups");
  const writer = createClient({ url: databaseUrl });
  // Keep writing while snapshots run; neither side may fail with SQLITE_BUSY.
  let writing = true;
  const writes = (async () => {
    let count = 0;
    while (writing) {
      await writer.execute({ sql: "INSERT INTO item (body) VALUES (?)", args: [`during ${count++}`] });
      await Bun.sleep(1);
    }
    return count;
  })();
  const created = [];
  for (const [index, now] of [Date.UTC(2026, 0, 1), Date.UTC(2026, 0, 2), Date.UTC(2026, 0, 3)].entries())
    created[index] = await Backup.create({ databaseUrl, directory, keep: 2, now });
  writing = false;
  expect(await writes).toBeGreaterThan(0);
  writer.close();
  expect(created.map((backup) => backup?.name)).toEqual([
    "nimbus-20260101T000000Z.sqlite",
    "nimbus-20260102T000000Z.sqlite",
    "nimbus-20260103T000000Z.sqlite",
  ]);
  expect((await readdir(directory)).sort()).toEqual([
    "nimbus-20260102T000000Z.sqlite",
    "nimbus-20260103T000000Z.sqlite",
  ]);
  expect((await stat(directory)).mode & 0o777).toBe(0o700);
  const latest = Backup.file(directory, "nimbus-20260103T000000Z.sqlite");
  if (!latest) throw new Error("The latest backup name was rejected.");
  expect((await stat(latest)).mode & 0o777).toBe(0o600);
  const snapshot = createClient({ url: `file:${latest}` });
  const rows = await snapshot.execute("SELECT body FROM item ORDER BY id LIMIT 1");
  expect(rows.rows[0]?.body).toBe("committed before the backup");
  snapshot.close();
});

test("backup names are validated before they become paths", () => {
  expect(Backup.file("/config/backups", "../db.sqlite")).toBeNull();
  expect(Backup.file("/config/backups", "nimbus-20260103T000000Z.sqlite.partial")).toBeNull();
});

test("a failed snapshot leaves earlier backups and no partial file", async () => {
  const directory = path.join(root, "backups");
  await Backup.create({ databaseUrl, directory, keep: 3, now: Date.UTC(2026, 0, 1) });
  await expect(
    Backup.create({ databaseUrl: `file:${path.join(root, "missing", "db.sqlite")}`, directory, keep: 3, now: Date.UTC(2026, 0, 2) }),
  ).rejects.toThrow("Earlier backups are unchanged");
  expect(await readdir(directory)).toEqual(["nimbus-20260101T000000Z.sqlite"]);
});

test("scheduled backups run only when the newest is older than the interval", async () => {
  const directory = path.join(root, "backups");
  const schedule = Backup.scheduler(() => ({ databaseUrl, directory, keep: 3 }), 60_000);
  const first = await schedule.runIfDue();
  expect(first).not.toBeNull();
  expect(await schedule.runIfDue()).toBeNull();
});

test("the retention setting is validated", async () => {
  const { backupsToKeep } = await import("./backup");
  expect(backupsToKeep(undefined)).toBe(7);
  expect(backupsToKeep("3")).toBe(3);
  expect(() => backupsToKeep("0")).toThrow("NIMBUS_BACKUP_KEEP");
  expect(() => backupsToKeep("two")).toThrow("NIMBUS_BACKUP_KEEP");
});

test("remote databases are refused with guidance instead of a partial backup", async () => {
  await expect(
    Backup.create({ databaseUrl: "libsql://example.turso.io", directory: path.join(root, "backups"), keep: 1 }),
  ).rejects.toThrow("Backups need a local SQLite database");
});
