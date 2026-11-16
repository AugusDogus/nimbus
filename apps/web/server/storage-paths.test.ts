import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { databaseFile, getConfigRoot, getDatabaseUrl } from "./storage-paths";

let root: string;
let previous: NodeJS.ProcessEnv;

beforeEach(async () => {
  previous = { ...process.env };
  root = await mkdtemp(path.join(os.tmpdir(), "nimbus-storage-"));
  process.env.NIMBUS_DATA_ROOT = path.join(root, "data");
  delete process.env.NIMBUS_CONFIG_ROOT;
  delete process.env.DATABASE_URL;
});

afterEach(async () => {
  for (const key of [
    "NIMBUS_DATA_ROOT",
    "NIMBUS_CONFIG_ROOT",
    "DATABASE_URL",
  ]) {
    if (previous[key] === undefined) delete process.env[key];
    else process.env[key] = previous[key];
  }
  await rm(root, { recursive: true, force: true });
});

test("existing local installations retain their default state directory", () => {
  expect(getConfigRoot()).toBe(path.join(root, "data/.nimbus"));
  expect(getDatabaseUrl()).toBe(`file:${root}/data/.nimbus/db.sqlite`);
});

test("a separate config directory holds the database and respects explicit URLs", () => {
  process.env.NIMBUS_CONFIG_ROOT = path.join(root, "config");
  expect(getConfigRoot()).toBe(path.join(root, "config"));
  expect(getDatabaseUrl()).toBe(`file:${root}/config/db.sqlite`);
  process.env.DATABASE_URL = `file:${root}/custom.sqlite`;
  expect(getDatabaseUrl()).toBe(process.env.DATABASE_URL);
});

test("switching config roots requires migrating an existing default database", async () => {
  const legacy = path.join(root, "data/.nimbus");
  await mkdir(legacy, { recursive: true });
  const original = new Database(databaseFile(getDatabaseUrl()));
  try {
    original.run("CREATE TABLE user (id TEXT PRIMARY KEY, name TEXT)");
    original.run(
      "INSERT INTO user VALUES ('existing', 'Existing administrator')",
    );
  } finally {
    original.close();
  }
  process.env.NIMBUS_CONFIG_ROOT = path.join(root, "config");
  expect(getDatabaseUrl).toThrow("Stop Nimbus");
  await mkdir(getConfigRoot());
  await copyFile(
    path.join(legacy, "db.sqlite"),
    path.join(getConfigRoot(), "db.sqlite"),
  );
  expect(getDatabaseUrl()).toBe(`file:${root}/config/db.sqlite`);
  const relocated = new Database(databaseFile(getDatabaseUrl()));
  try {
    expect(relocated.query("SELECT id, name FROM user").values()).toEqual([
      ["existing", "Existing administrator"],
    ]);
  } finally {
    relocated.close();
  }
});

test("config cannot expose application state inside the browsable drive", () => {
  process.env.NIMBUS_CONFIG_ROOT = path.join(root, "data/config");
  expect(getConfigRoot).toThrow("outside the data root");
  process.env.NIMBUS_CONFIG_ROOT = path.join(root, "data");
  expect(getConfigRoot).toThrow("outside the data root");
});
