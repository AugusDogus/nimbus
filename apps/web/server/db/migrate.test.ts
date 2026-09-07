import { afterEach, beforeEach, expect, test } from "bun:test";
import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const migrationsFolder = fileURLToPath(
  new URL("../../drizzle", import.meta.url),
);
let client: Client;

beforeEach(() => {
  client = createClient({ url: "file::memory:" });
});
afterEach(() => {
  client.close();
});

test("fresh database migrations can be rerun and preserve the last active administrator", async () => {
  const db = drizzle(client);
  await migrate(db, { migrationsFolder });
  await migrate(db, { migrationsFolder });
  await client.execute(
    "INSERT INTO user (id, name, email, role) VALUES ('first', 'First', 'first@example.test', 'admin')",
  );
  await expect(
    client.execute("UPDATE user SET role = 'user' WHERE id = 'first'"),
  ).rejects.toThrow("Nimbus requires an active administrator");
  await expect(
    client.execute("UPDATE user SET banned = 1 WHERE id = 'first'"),
  ).rejects.toThrow("Nimbus requires an active administrator");
  await expect(
    client.execute("DELETE FROM user WHERE id = 'first'"),
  ).rejects.toThrow("Nimbus requires an active administrator");
  await client.execute(
    "INSERT INTO user (id, name, email, role) VALUES ('second', 'Second', 'second@example.test', 'user,admin')",
  );
  await client.execute("UPDATE user SET role = 'user' WHERE id = 'first'");
  const result = await client.execute("SELECT id, role FROM user ORDER BY id");
  expect(result.rows.map((row) => [row.id, row.role])).toEqual([
    ["first", "user"],
    ["second", "user,admin"],
  ]);
  await expect(
    client.execute("DELETE FROM user WHERE id = 'second'"),
  ).rejects.toThrow("Nimbus requires an active administrator");
});

test("upgrading the original schema retains users and sessions and promotes its oldest account", async () => {
  const baseline = await readFile(
    new URL("../../drizzle/0000_dusty_prima.sql", import.meta.url),
    "utf8",
  );
  await client.batch(
    baseline
      .split("--> statement-breakpoint")
      .filter((statement) => statement.trim()),
    "write",
  );
  await client.execute(
    "INSERT INTO user (id, name, email, created_at) VALUES ('older', 'Original owner', 'older@example.test', 100), ('newer', 'Existing member', 'newer@example.test', 200)",
  );
  await client.execute(
    "INSERT INTO session (id, expires_at, token, updated_at, user_id) VALUES ('session', 9999999999999, 'existing-session', 100, 'older')",
  );
  await migrate(drizzle(client), { migrationsFolder });
  const users = await client.execute(
    "SELECT id, name, role, banned FROM user ORDER BY created_at",
  );
  expect(
    users.rows.map((row) => [row.id, row.name, row.role, row.banned]),
  ).toEqual([
    ["older", "Original owner", "admin", 0],
    ["newer", "Existing member", "user", 0],
  ]);
  const sessions = await client.execute(
    "SELECT token, impersonated_by FROM session",
  );
  expect(sessions.rows.map((row) => [row.token, row.impersonated_by])).toEqual([
    ["existing-session", null],
  ]);
  await client.execute(
    "INSERT INTO nimbus_group (id, name) VALUES ('group', 'Team')",
  );
});
