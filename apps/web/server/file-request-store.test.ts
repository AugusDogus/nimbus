import { afterEach, beforeEach, expect, test } from "bun:test";
import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FileRequest } from "@nimbus/api/file-request";
import * as schema from "./db/schema";
import {
  createFileRequestStore,
  FileRequestRecords,
} from "./file-request-store";

let client: Client;
let directory: string;
let database: ReturnType<typeof drizzle<typeof schema>>;
let store: ReturnType<typeof createFileRequestStore>;
const request: FileRequest = {
  id: "request",
  token: "token",
  path: "inbox",
  createdBy: "owner",
  createdAt: 0,
  expiresAt: null,
  passwordHash: null,
  note: null,
  maxFileBytes: null,
  maxFiles: 3,
  maxTotalBytes: 250,
};
const upload = (id: string, size: number, createdAt = 1000) => ({
  id,
  requestId: "request",
  uploaderHash: "uploader",
  size,
  createdAt,
});

beforeEach(async () => {
  // A file, not :memory:, because libsql runs transactions on a separate connection.
  directory = await mkdtemp(path.join(os.tmpdir(), "nimbus-file-requests-"));
  client = createClient({ url: `file:${path.join(directory, "db.sqlite")}` });
  database = drizzle(client, { schema });
  await migrate(database, {
    migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
  });
  await client.execute(
    "INSERT INTO user (id, name, email, role) VALUES ('owner', 'Owner', 'owner@example.test', 'admin')",
  );
  store = createFileRequestStore(database);
  await store.create(request);
});
afterEach(async () => {
  client.close();
  await rm(directory, { recursive: true, force: true });
});

const options = { activeSince: 0, maxActive: 10 };

test("concurrent reservations never exceed the byte or file limit", async () => {
  const results = await Promise.all(
    ["a", "b", "c", "d"].map((id) => store.reserve(upload(id, 100), options)),
  );
  expect(results.filter((result) => result.kind === "reserved")).toHaveLength(
    2,
  );
  expect(results.filter((result) => result.kind === "byte-limit")).toHaveLength(
    2,
  );
  expect(await store.reserve(upload("e", 50), options)).toEqual({
    kind: "reserved",
  });
  expect(await store.reserve(upload("f", 0), options)).toEqual({
    kind: "file-limit",
  });
});

test("abandoned reservations stop holding quota and finished uploads are counted", async () => {
  expect(await store.reserve(upload("old", 200, 10), options)).toEqual({
    kind: "reserved",
  });
  expect(await store.reserve(upload("new", 100), options)).toEqual({
    kind: "byte-limit",
  });
  // A day later the stale upload's staging is gone, so its reservation lapses.
  expect(
    await store.reserve(upload("new", 100), { ...options, activeSince: 500 }),
  ).toEqual({ kind: "reserved" });
  await store.finishUpload("new", "report.pdf", 2000);
  await store.releaseAbandoned(500);
  expect(await store.getUpload("old")).toBeNull();
  expect(await store.list("owner")).toMatchObject([
    { id: "request", received: { files: 1, bytes: 100 } },
  ]);
});

test("each link limits how many uploads may run at once", async () => {
  const busy = { activeSince: 0, maxActive: 1 };
  expect(await store.reserve(upload("a", 1), busy)).toEqual({
    kind: "reserved",
  });
  expect(await store.reserve(upload("b", 1), busy)).toEqual({ kind: "busy" });
  await store.finishUpload("a", "a.txt", 2000);
  expect(await store.reserve(upload("b", 1), busy)).toEqual({
    kind: "reserved",
  });
  await store.revoke("request", "owner");
  expect(await store.reserve(upload("c", 1), busy)).toEqual({
    kind: "unavailable",
  });
});

test("records follow moves, are suspended in trash and come back on restore", async () => {
  // Core's movePath, addTrash and restoreTrash run these inside their own transactions.
  await store.create({
    ...request,
    id: "nested",
    token: "nested-token",
    path: "inbox/sub",
  });
  await store.create({
    ...request,
    id: "sibling",
    token: "sibling-token",
    path: "inbox-2",
  });
  expect(await store.reserve(upload("a", 10), options)).toEqual({
    kind: "reserved",
  });
  await store.finishUpload("a", "inbox/a.txt", 2000);
  await database.transaction((tx) =>
    FileRequestRecords.relocate(tx, "inbox", "archive/inbox"),
  );
  const paths = async () =>
    (await store.list("owner"))
      .map((row) => [row.id, row.path] as const)
      .sort();
  expect(await paths()).toEqual([
    ["nested", "archive/inbox/sub"],
    ["request", "archive/inbox"],
    ["sibling", "inbox-2"],
  ]);
  const detached = await database.transaction((tx) =>
    FileRequestRecords.detach(tx, "archive/inbox"),
  );
  expect(await paths()).toEqual([["sibling", "inbox-2"]]);
  expect(await store.getUpload("a")).toBeNull();
  // Suspended records round-trip through the trash row's JSON.
  const saved = FileRequestRecords.parse(JSON.parse(JSON.stringify(detached)));
  await database.transaction((tx) =>
    FileRequestRecords.reattach(tx, saved, new Set(["owner"])),
  );
  expect(
    (await store.list("owner")).find((row) => row.id === "request")?.received,
  ).toEqual({ files: 1, bytes: 10 });
  // Links of accounts removed while in trash are not restored.
  await database.transaction((tx) =>
    FileRequestRecords.detach(tx, "archive/inbox"),
  );
  await database.transaction((tx) =>
    FileRequestRecords.reattach(tx, saved, new Set()),
  );
  expect(await paths()).toEqual([["sibling", "inbox-2"]]);
});
