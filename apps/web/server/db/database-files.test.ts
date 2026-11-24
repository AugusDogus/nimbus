import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseFiles } from "./database-files";

let root: string;
let file: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "nimbus-db-files-"));
  file = path.join(root, "db.sqlite");
  const sqlite = new Database(file, { create: true });
  sqlite.run("PRAGMA journal_mode = WAL");
  sqlite.run("CREATE TABLE item (id INTEGER PRIMARY KEY)");
  sqlite.close();
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const asRoot = process.getuid?.() === 0; // root ignores permission bits

test.skipIf(asRoot)(
  "a database Nimbus can read but not write fails the write probe",
  async () => {
    await chmod(file, 0o444);
    const sqlite = new Database(file, { create: true });
    try {
      expect(sqlite.query("SELECT 1 AS ok").get()).toEqual({ ok: 1 });
      expect(() => DatabaseFiles.requireWritable(sqlite, file)).toThrow(
        "Nimbus cannot write to its database",
      );
      expect(() => DatabaseFiles.probeWrite(sqlite)).toThrow();
    } finally {
      sqlite.close();
    }
  },
);

test("the write probe changes nothing in a writable database", () => {
  const sqlite = new Database(file);
  try {
    sqlite.run("PRAGMA user_version = 7");
    DatabaseFiles.requireWritable(sqlite, file);
    expect(sqlite.query("PRAGMA user_version").get()).toEqual({
      user_version: 7,
    });
    expect(sqlite.query("SELECT count(*) AS n FROM item").get()).toEqual({
      n: 0,
    });
  } finally {
    sqlite.close();
  }
});

test("the database and its journal files become private to the server's user", async () => {
  const sqlite = new Database(file);
  try {
    sqlite.run("INSERT INTO item DEFAULT VALUES");
    for (const name of ["db.sqlite", "db.sqlite-wal", "db.sqlite-shm"])
      await chmod(path.join(root, name), 0o644);
    DatabaseFiles.restrict(file);
    for (const name of ["db.sqlite", "db.sqlite-wal", "db.sqlite-shm"])
      expect((await stat(path.join(root, name))).mode & 0o777).toBe(0o600);
  } finally {
    sqlite.close();
  }
  // Missing companions are not an error.
  await rm(path.join(root, "db.sqlite-wal"), { force: true });
  DatabaseFiles.restrict(file);
});

test.skipIf(asRoot)(
  "startup stops when it cannot make the database or config root private",
  () => {
    // Owned by root, so chmod fails as it does for a restored file under --user.
    expect(() => DatabaseFiles.restrict("/proc/version")).toThrow(
      "could not make /proc/version private",
    );
    expect(() => DatabaseFiles.restrictDirectory("/proc")).toThrow(
      "could not make /proc private",
    );
  },
);

test("a config root the entrypoint shares (sticky, not this user's, closed to others) is left as it is", () => {
  const uid = process.getuid?.() ?? 1000;
  const shared = { uid: 0, mode: 0o41771 };
  expect(DatabaseFiles.sharedConfigRoot(shared, uid)).toBe(true);
  // Anything else is made private as before: this user's own, not sticky, or open to others.
  for (const other of [
    { uid, mode: 0o41771 },
    { uid: 0, mode: 0o40771 },
    { uid: 0, mode: 0o41775 },
    { uid: 0, mode: 0o41777 },
  ])
    expect(DatabaseFiles.sharedConfigRoot(other, uid)).toBe(false);
});
