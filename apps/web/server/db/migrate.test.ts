import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database as SQLite } from "bun:sqlite";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { openDatabase, type Database } from "./index";
import { migrateDatabase } from "./migrate-database";

const migrationsFolder = fileURLToPath(
  new URL("../../drizzle", import.meta.url),
);
let client: SQLite;
let db: Database;

beforeEach(() => {
  ({ sqlite: client, db } = openDatabase(":memory:"));
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
  migrateDatabase(client, db);
  migrateDatabase(client, db);
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

test("connections enforce foreign keys after migrating", () => {
  migrateDatabase(client, db);
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
  migrateDatabase(client, db);
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
