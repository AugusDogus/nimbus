import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database as SQLite } from "bun:sqlite";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase } from "./connection";
import { migrateDatabase } from "./migrate-database";

const migrationsFolder = fileURLToPath(
  new URL("../../drizzle", import.meta.url),
);
let client: SQLite;

beforeEach(() => {
  ({ sqlite: client } = openDatabase(":memory:"));
});
afterEach(() => {
  client.close();
});

/** Run the statements of one committed migration file. */
async function runMigration(name: string) {
  const text = await readFile(
    new URL(`../../drizzle/${name}`, import.meta.url),
    "utf8",
  );
  for (const statement of text.split("--> statement-breakpoint"))
    if (statement.trim()) client.run(statement);
}

test("fresh database migrations can be rerun and preserve the last active administrator", () => {
  migrateDatabase(client);
  migrateDatabase(client);
  client.run(
    "INSERT INTO user (id, name, email, role) VALUES ('first', 'First', 'first@example.test', 'admin')",
  );
  expect(() =>
    client.run("UPDATE user SET role = 'user' WHERE id = 'first'"),
  ).toThrow("Nimbus requires an active administrator");
  expect(() =>
    client.run("UPDATE user SET banned = 1 WHERE id = 'first'"),
  ).toThrow("Nimbus requires an active administrator");
  expect(() => client.run("DELETE FROM user WHERE id = 'first'")).toThrow(
    "Nimbus requires an active administrator",
  );
  client.run(
    "INSERT INTO user (id, name, email, role) VALUES ('second', 'Second', 'second@example.test', 'user,admin')",
  );
  client.run("UPDATE user SET role = 'user' WHERE id = 'first'");
  expect(
    client.query("SELECT id, role FROM user ORDER BY id").values(),
  ).toEqual([
    ["first", "user"],
    ["second", "user,admin"],
  ]);
  expect(() => client.run("DELETE FROM user WHERE id = 'second'")).toThrow(
    "Nimbus requires an active administrator",
  );
});

/** A migrations folder holding `migrations`, in order. */
async function migrationsFixture(migrations: string[]) {
  const folder = await mkdtemp(path.join(os.tmpdir(), "nimbus-migrations-"));
  await mkdir(path.join(folder, "meta"));
  const entries = migrations.map((_, idx) => ({
    idx,
    version: "6",
    when: 1000 + idx,
    tag: `000${idx}_fixture`,
    breakpoints: true,
  }));
  await writeFile(
    path.join(folder, "meta", "_journal.json"),
    JSON.stringify({ version: "7", dialect: "sqlite", entries }),
  );
  await Promise.all(
    migrations.map((text, idx) =>
      writeFile(path.join(folder, `000${idx}_fixture.sql`), text),
    ),
  );
  return folder;
}

test("a migration that leaves orphaned rows is rolled back before it is recorded", async () => {
  const parent =
    "CREATE TABLE parent (id text PRIMARY KEY);--> statement-breakpoint\nCREATE TABLE child (parent_id text REFERENCES parent(id));";
  const orphan = "INSERT INTO child (parent_id) VALUES ('missing');";
  const first = await migrationsFixture([parent]);
  const both = await migrationsFixture([parent, orphan]);
  try {
    migrateDatabase(client, { migrationsFolder: first });
    expect(() => migrateDatabase(client, { migrationsFolder: both })).toThrow(
      "rolled back",
    );
    expect(
      client.query("SELECT count(*) AS n FROM __drizzle_migrations").get(),
    ).toEqual({ n: 1 });
    expect(client.query("SELECT count(*) AS n FROM child").get()).toEqual({
      n: 0,
    });
    expect(() =>
      client.run("INSERT INTO child (parent_id) VALUES ('missing')"),
    ).toThrow("FOREIGN KEY constraint failed");
  } finally {
    await rm(first, { recursive: true, force: true });
    await rm(both, { recursive: true, force: true });
  }
});

test("connections enforce foreign keys after migrating", () => {
  migrateDatabase(client);
  expect(() =>
    client.run(
      "INSERT INTO nimbus_group_member (group_id, user_id) VALUES ('missing', 'missing')",
    ),
  ).toThrow("FOREIGN KEY constraint failed");
});

test("upgrading the original schema retains users and sessions and promotes its oldest account", async () => {
  await runMigration("0000_dusty_prima.sql");
  client.run(
    "INSERT INTO user (id, name, email, created_at) VALUES ('older', 'Original owner', 'older@example.test', 100), ('newer', 'Existing member', 'newer@example.test', 200)",
  );
  client.run(
    "INSERT INTO session (id, expires_at, token, updated_at, user_id) VALUES ('session', 9999999999999, 'existing-session', 100, 'older')",
  );
  migrateDatabase(client);
  expect(
    client
      .query("SELECT id, name, role, banned FROM user ORDER BY created_at")
      .values(),
  ).toEqual([
    ["older", "Original owner", "admin", 0],
    ["newer", "Existing member", "user", 0],
  ]);
  expect(
    client.query("SELECT token, impersonated_by FROM session").values(),
  ).toEqual([["existing-session", null]]);
  client.run("INSERT INTO nimbus_group (id, name) VALUES ('group', 'Team')");
});

test("upgrading discards inode-keyed version records, which cannot be mapped to paths", async () => {
  const files = (await readdir(migrationsFolder))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const pathKeyed = files.findIndex((name) => name.includes("path_keyed"));
  for (const name of files.slice(0, pathKeyed)) await runMigration(name);
  client.run(
    "INSERT INTO nimbus_file_version (id, file_key, name, size, modified_at, archived_at) VALUES ('v', '123:456', 'a.txt', 1, 1, 1)",
  );
  for (const name of files.slice(pathKeyed)) await runMigration(name);
  expect(
    client.query("SELECT count(*) AS n FROM nimbus_file_version").get(),
  ).toEqual({ n: 0 });
  client.run(
    "INSERT INTO nimbus_file_version (id, path, name, size, modified_at, archived_at) VALUES ('w', 'docs/a.txt', 'a.txt', 1, 1, 1)",
  );
});
