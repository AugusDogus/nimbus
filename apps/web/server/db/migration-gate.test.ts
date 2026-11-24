import { afterEach, beforeEach, expect, test } from "bun:test";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { openDatabase } from "./connection";
import { MigrationGate } from "./migration-gate";
import { migrateDatabase } from "./migrate-database";

const journalSchema = z.object({
  entries: z.array(z.looseObject({ tag: z.string(), when: z.number() })),
});
const migrations = fileURLToPath(new URL("../../drizzle", import.meta.url));
let directory: string;
let folder: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "nimbus-gate-"));
  folder = path.join(directory, "drizzle");
  await cp(migrations, folder, { recursive: true });
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

/** A database migrated up to, and not including, the last `pending` migrations. */
async function databaseWith(pending: number) {
  const partial = path.join(directory, "partial");
  await cp(folder, partial, { recursive: true });
  const journal = path.join(partial, "meta/_journal.json");
  const { entries } = journalSchema.parse(await Bun.file(journal).json());
  await writeFile(
    journal,
    JSON.stringify({
      version: "7",
      dialect: "sqlite",
      entries: entries.slice(0, entries.length - pending),
    }),
  );
  const opened = openDatabase(":memory:");
  migrateDatabase(opened.sqlite, { migrationsFolder: partial });
  return opened.sqlite;
}

const declare = (tags: string[]) =>
  writeFile(
    path.join(folder, "live-safe.json"),
    JSON.stringify({ safeBesideOlderServer: tags }),
  );
const lastTags = async (count: number) => {
  const { entries } = journalSchema.parse(
    await Bun.file(path.join(folder, "meta/_journal.json")).json(),
  );
  return entries.slice(-count).map((entry) => entry.tag);
};

test("nothing pending, nothing to decide", async () => {
  const sqlite = await databaseWith(0);
  expect(MigrationGate.check(sqlite, folder)).toEqual({ kind: "none" });
});

test("pending migrations the release declares safe beside an older server", async () => {
  const sqlite = await databaseWith(2);
  const tags = await lastTags(2);
  await declare(tags);
  expect(MigrationGate.check(sqlite, folder)).toEqual({
    kind: "safe",
    pending: tags,
  });
});

test("one pending migration the release does not declare makes it a full restart", async () => {
  const sqlite = await databaseWith(2);
  const tags = await lastTags(2);
  await declare(tags.slice(0, 1));
  const checked = MigrationGate.check(sqlite, folder);
  expect(checked.kind).toBe("full-restart");
  if (checked.kind === "full-restart")
    expect(checked.reason).toContain(tags[1]);
});

test("a release that declares nothing gets a full restart", async () => {
  const sqlite = await databaseWith(1);
  await rm(path.join(folder, "live-safe.json"), { force: true });
  expect(MigrationGate.check(sqlite, folder).kind).toBe("full-restart");
});

test("an unreadable declaration is the same as none", async () => {
  const sqlite = await databaseWith(1);
  await writeFile(path.join(folder, "live-safe.json"), "{ not json");
  expect(MigrationGate.check(sqlite, folder).kind).toBe("full-restart");
});

test("this repository declares only migrations it has", async () => {
  const { entries } = journalSchema.parse(
    await Bun.file(path.join(migrations, "meta/_journal.json")).json(),
  );
  const declared = z
    .object({ safeBesideOlderServer: z.array(z.string()) })
    .parse(await Bun.file(path.join(migrations, "live-safe.json")).json());
  const tags = new Set(entries.map((entry) => entry.tag));
  expect(
    declared.safeBesideOlderServer.filter((tag) => !tags.has(tag)),
  ).toEqual([]);
});

/** A copy of the migrations as an older release has them: without its last `count`. */
async function olderRelease(count: number) {
  const older = path.join(directory, `older-${count}`);
  await cp(folder, older, { recursive: true });
  const journal = path.join(older, "meta/_journal.json");
  const { entries } = journalSchema.parse(await Bun.file(journal).json());
  await writeFile(
    journal,
    JSON.stringify({
      version: "7",
      dialect: "sqlite",
      entries: entries.slice(0, -count),
    }),
  );
  return older;
}

test("the same release finds nothing newer", async () => {
  const { sqlite } = openDatabase(":memory:");
  migrateDatabase(sqlite, { migrationsFolder: folder });
  expect(MigrationGate.newerRelease(sqlite, folder)).toEqual({ kind: "none" });
});

test("an older release may run on migrations the newer one declared safe beside it", async () => {
  const newest = await lastTags(2);
  await declare(newest);
  const { sqlite } = openDatabase(":memory:");
  migrateDatabase(sqlite, { migrationsFolder: folder });
  expect(MigrationGate.newerRelease(sqlite, await olderRelease(2))).toEqual({
    kind: "safe",
    migrations: newest,
  });
});

test("an older release refuses a database with a newer migration not declared safe beside it", async () => {
  const newest = await lastTags(2);
  await declare(newest.slice(0, 1));
  const { sqlite } = openDatabase(":memory:");
  migrateDatabase(sqlite, { migrationsFolder: folder });
  expect(MigrationGate.newerRelease(sqlite, await olderRelease(2))).toEqual({
    kind: "unsafe",
    migrations: newest,
  });
});

test("a newer migration nothing records the safety of counts as unsafe", async () => {
  await declare(await lastTags(1));
  const { sqlite } = openDatabase(":memory:");
  migrateDatabase(sqlite, { migrationsFolder: folder });
  sqlite.run("DROP TABLE nimbus_migration_safety");
  const newer = MigrationGate.newerRelease(sqlite, await olderRelease(1));
  expect(newer.kind).toBe("unsafe");
  if (newer.kind === "unsafe")
    expect(newer.migrations[0]).toStartWith("one applied at ");
});
