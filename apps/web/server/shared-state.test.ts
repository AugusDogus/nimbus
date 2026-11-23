import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "./db/connection";
import { migrateDatabase } from "./db/migrate-database";
import { createDriveStore } from "./drive-store";
import { UploadClaims } from "./mcp/upload-claims";

/**
 * During an update the supervisor runs two servers side by side on one database. Each test
 * opens two connections to one database file, as the two servers would, and checks that what
 * one server did is seen by the other, so nothing can happen twice.
 */
let directory: string;
let servers: [ReturnType<typeof openDatabase>, ReturnType<typeof openDatabase>];

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "nimbus-shared-state-"));
  const file = path.join(directory, "db.sqlite");
  const first = openDatabase(file);
  migrateDatabase(first.sqlite);
  servers = [first, openDatabase(file)];
});
afterEach(async () => {
  for (const server of servers) server.sqlite.close();
  await rm(directory, { recursive: true, force: true });
});

describe("undo claims", () => {
  test("a receipt undone on one server cannot be undone on the other", async () => {
    const [old, next] = servers.map((server) => createDriveStore(server.db));
    if (!old || !next) throw new Error("two servers");
    expect(await old.claimUndo("receipt-1", 10_000, 1_000)).toBe(true);
    expect(await next.claimUndo("receipt-1", 10_000, 1_000)).toBe(false);
    expect(await old.claimUndo("receipt-1", 10_000, 1_000)).toBe(false);
  });

  test("a released claim can be taken again, by either server", async () => {
    const [old, next] = servers.map((server) => createDriveStore(server.db));
    if (!old || !next) throw new Error("two servers");
    expect(await old.claimUndo("receipt-1", 10_000, 1_000)).toBe(true);
    await old.releaseUndo("receipt-1");
    expect(await next.claimUndo("receipt-1", 10_000, 1_000)).toBe(true);
  });

  test("expired claims are forgotten", async () => {
    const [old, next] = servers.map((server) => createDriveStore(server.db));
    if (!old || !next) throw new Error("two servers");
    expect(await old.claimUndo("receipt-1", 2_000, 1_000)).toBe(true);
    expect(await next.claimUndo("receipt-1", 9_000, 2_000)).toBe(true);
    expect(
      servers[0].sqlite
        .query<{ id: string }, []>("SELECT id FROM nimbus_undone_receipt")
        .all(),
    ).toEqual([{ id: "receipt-1" }]);
  });

  test("of many concurrent claims across both servers, exactly one wins", async () => {
    const stores = servers.map((server) => createDriveStore(server.db));
    const claims = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        stores[index % 2]?.claimUndo("receipt-1", 10_000, 1_000),
      ),
    );
    expect(claims.filter(Boolean)).toHaveLength(1);
  });
});

describe("MCP upload claims", () => {
  test("a path one server committed for a link is refused on the other", () => {
    const [old, next] = servers;
    expect(UploadClaims.claim(old.db, "link/path", 10_000, 1_000)).toBe(true);
    expect(UploadClaims.claimed(next.db, "link/path", 1_000)).toBe(true);
    expect(UploadClaims.claim(next.db, "link/path", 10_000, 1_000)).toBe(false);
  });

  test("a released claim lets the link upload the path again", () => {
    const [old, next] = servers;
    expect(UploadClaims.claim(old.db, "link/path", 10_000, 1_000)).toBe(true);
    UploadClaims.release(old.db, "link/path");
    expect(UploadClaims.claimed(next.db, "link/path", 1_000)).toBe(false);
    expect(UploadClaims.claim(next.db, "link/path", 10_000, 1_000)).toBe(true);
  });

  test("claims end with their link", () => {
    const [old, next] = servers;
    expect(UploadClaims.claim(old.db, "link/path", 2_000, 1_000)).toBe(true);
    expect(UploadClaims.claimed(next.db, "link/path", 2_000)).toBe(false);
    expect(UploadClaims.claim(next.db, "link/path", 9_000, 2_000)).toBe(true);
  });
});
