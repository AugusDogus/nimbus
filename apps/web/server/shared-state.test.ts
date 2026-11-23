import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "./db/connection";
import { migrateDatabase } from "./db/migrate-database";
import { createDriveStore } from "./drive-store";
import {
  FileLockedError,
  lockFile,
  locksCovering,
  requireUnlocked,
  unlockFile,
  setFileLockStore,
} from "@nimbus/api/file-mutations";
import { DavLockStore } from "./dav-lock-store";
import { GuessBudgets } from "./guess-budgets";
import { LinkPasswordAttempts } from "./link-password-attempts";
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
  setFileLockStore(null);
  GuessBudgets.keepIn(null);
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

describe("MCP upload reservations", () => {
  const at = (time: number) => () => time;

  test("a path one server is uploading for a link is refused on the other until it ends", () => {
    const [old, next] = servers;
    expect(
      UploadClaims.reserve(old.db, "link/path", 10_000, "old", at(1_000)),
    ).toEqual({ kind: "reserved" });
    expect(
      UploadClaims.reserve(next.db, "link/path", 10_000, "next", at(1_000)),
    ).toEqual({ kind: "running" });
    UploadClaims.commit(old.db, "link/path");
    expect(
      UploadClaims.reserve(next.db, "link/path", 10_000, "next", at(2_000)),
    ).toEqual({ kind: "committed" });
  });

  test("reads the clock only once it holds the database's write lock", () => {
    const [old, next] = servers;
    next.sqlite.run("PRAGMA busy_timeout = 0");
    const writable: boolean[] = [];
    UploadClaims.reserve(old.db, "link/path", 10_000, "old", () => {
      try {
        next.sqlite.run(
          "INSERT INTO nimbus_mcp_upload_claim (key, expires_at) VALUES ('other/path', 1)",
        );
        writable.push(true);
      } catch {
        writable.push(false);
      }
      return 1_000;
    });
    // Another server committing meanwhile would make the time read stale.
    expect(writable).toEqual([false]);
  });

  test("an upload still running long after its link expired keeps the path", () => {
    const [old, next] = servers;
    expect(
      UploadClaims.reserve(old.db, "link/path", 10_000, "old", at(1_000)).kind,
    ).toBe("reserved");
    // Two days later another link's admission prunes what expired.
    const later = 10_000 + 2 * 24 * 60 * 60 * 1000;
    expect(
      UploadClaims.reserve(
        next.db,
        "other/path",
        later + 50_000,
        "next",
        at(later),
      ).kind,
    ).toBe("reserved");
    const kept = old.sqlite
      .query<{ state: string }, []>(
        "SELECT state FROM nimbus_mcp_upload_claim WHERE key = 'link/path'",
      )
      .get();
    expect(kept?.state).toBe("reserved");
    UploadClaims.commit(old.db, "link/path");
    expect(
      UploadClaims.reserve(next.db, "link/path", 10_000, "next", at(later))
        .kind,
    ).toBe("expired");
  });

  test("a server that exited leaves its paths taken until its link expires, as it may have written them", () => {
    const [old, next] = servers;
    UploadClaims.reserve(old.db, "link/a", 10_000, "old", at(1_000));
    UploadClaims.reserve(next.db, "link/b", 10_000, "next", at(1_000));
    UploadClaims.settleOwnedBy(next.db, "old");
    // The exited server's reservation counts as written; the live one is still running.
    expect(
      UploadClaims.reserve(next.db, "link/a", 10_000, "next", at(2_000)),
    ).toEqual({ kind: "committed" });
    expect(
      UploadClaims.reserve(old.db, "link/b", 10_000, "old", at(2_000)),
    ).toEqual({ kind: "running" });
    // Once the link expired, both go.
    UploadClaims.settleAll(next.db);
    UploadClaims.reserve(next.db, "other/c", 90_000, "next", at(20_000));
    expect(
      old.sqlite
        .query<{ key: string }, []>("SELECT key FROM nimbus_mcp_upload_claim")
        .all(),
    ).toEqual([{ key: "other/c" }]);
  });

  test("a released reservation lets the link upload the path again", () => {
    const [old, next] = servers;
    expect(
      UploadClaims.reserve(old.db, "link/path", 10_000, "old", at(1_000)).kind,
    ).toBe("reserved");
    UploadClaims.release(old.db, "link/path");
    expect(
      UploadClaims.reserve(next.db, "link/path", 10_000, "next", at(1_000))
        .kind,
    ).toBe("reserved");
  });

  test("a release never gives up a committed path", () => {
    const [old, next] = servers;
    UploadClaims.reserve(old.db, "link/path", 10_000, "old", at(1_000));
    UploadClaims.commit(old.db, "link/path");
    UploadClaims.release(next.db, "link/path");
    expect(
      UploadClaims.reserve(next.db, "link/path", 10_000, "next", at(1_000))
        .kind,
    ).toBe("committed");
  });
});

describe("WebDAV locks", () => {
  const owner = { userId: "owner" };

  beforeEach(() => {
    servers[0].sqlite.run(
      "INSERT INTO user (id, name, email, role) VALUES ('owner', 'Owner', 'owner@example.test', 'admin'), ('other', 'Other', 'other@example.test', 'user')",
    );
  });

  test("a lock one server granted holds on the other, until its owner unlocks it there", () => {
    setFileLockStore(DavLockStore.create(servers[0].db));
    const lock = lockFile("docs/report.docx", owner);
    // The next server, with nothing in memory from the first.
    setFileLockStore(DavLockStore.create(servers[1].db));
    expect(locksCovering("docs/report.docx").map((held) => held.token)).toEqual(
      [lock.token],
    );
    expect(() =>
      requireUnlocked(["docs/report.docx"], { userId: "other" }),
    ).toThrow(FileLockedError);
    expect(() =>
      requireUnlocked(["docs/report.docx"], {
        userId: "owner",
        lockTokens: [lock.token],
      }),
    ).not.toThrow();
    unlockFile("docs/report.docx", "owner", `<${lock.token}>`);
    setFileLockStore(DavLockStore.create(servers[0].db));
    expect(locksCovering("docs/report.docx")).toEqual([]);
  });

  test("expired locks are ignored and deleted as locks change", () => {
    const store = DavLockStore.create(servers[0].db);
    const lock = {
      path: "docs",
      token: "opaquelocktoken:expired",
      userId: "owner",
      scope: "exclusive" as const,
      depth: "infinity" as const,
      owner: "",
      timeoutSeconds: 1,
      expiresAt: Date.now() - 1,
    };
    store.add(lock);
    expect(store.active(Date.now())).toEqual([]);
    store.add({
      ...lock,
      token: "opaquelocktoken:live",
      expiresAt: Date.now() + 60_000,
    });
    expect(
      servers[1].sqlite
        .query<{ token: string }, []>("SELECT token FROM nimbus_dav_lock")
        .all(),
    ).toEqual([{ token: "opaquelocktoken:live" }]);
  });

  test("a refresh on one server extends the lock for the other", () => {
    const first = DavLockStore.create(servers[0].db);
    const second = DavLockStore.create(servers[1].db);
    first.add({
      path: "docs",
      token: "opaquelocktoken:one",
      userId: "owner",
      scope: "shared",
      depth: "0",
      owner: "<D:href>client</D:href>",
      timeoutSeconds: 60,
      expiresAt: 61_000,
    });
    second.refresh("opaquelocktoken:one", 600, 601_000);
    expect(first.active(100_000)).toEqual([
      {
        path: "docs",
        token: "opaquelocktoken:one",
        userId: "owner",
        scope: "shared",
        depth: "0",
        owner: "<D:href>client</D:href>",
        timeoutSeconds: 600,
        expiresAt: 601_000,
      },
    ]);
  });
});

describe("password guess budgets", () => {
  const rule = { limit: 3, windowMs: 60_000 };

  test("a budget spent on one server is spent on the other", () => {
    const [old, next] = servers.map((server) =>
      GuessBudgets.durable(server.db).limiter("share-password-client", rule),
    );
    if (!old || !next) throw new Error("two servers");
    for (let guess = 0; guess < 3; guess++)
      expect(old.consume("198.51.100.0/24", 1_000).allowed).toBe(true);
    expect(next.consume("198.51.100.0/24", 1_000).allowed).toBe(false);
    // A right password given back on one server is given back on both.
    old.refund("198.51.100.0/24", 1_000);
    expect(next.consume("198.51.100.0/24", 1_000).allowed).toBe(true);
    // Other limiters and keys keep their own budgets.
    expect(next.consume("203.0.113.0/24", 1_000).allowed).toBe(true);
  });

  test("link password attempts keep their budget across an update", async () => {
    const attempts = LinkPasswordAttempts.create("share", {
      sleep: async () => undefined,
    });
    const request = () =>
      new Request("http://localhost/api/share/token", {
        headers: { "x-nimbus-client-ip": "198.51.100.7" },
      });
    GuessBudgets.keepIn(servers[0].db);
    for (let guess = 0; guess < 10; guess++)
      expect((await attempts.begin("link", request())).kind).toBe("admitted");
    // The next server, with nothing in memory from the first.
    GuessBudgets.keepIn(servers[1].db);
    expect((await attempts.begin("link", request())).kind).toBe("refused");
  });

  test("the sign-in throttle is counted once for every server", async () => {
    const [old, next] = servers.map((server) =>
      GuessBudgets.durable(server.db),
    );
    if (!old || !next) throw new Error("two servers");
    const signIn = { window: 60, max: 2 };
    expect((await old.auth.consume("ip|/sign-in/email", signIn)).allowed).toBe(
      true,
    );
    expect((await next.auth.consume("ip|/sign-in/email", signIn)).allowed).toBe(
      true,
    );
    const third = await old.auth.consume("ip|/sign-in/email", signIn);
    expect(third.allowed).toBe(false);
    expect(third.retryAfter).toBeGreaterThan(0);
  });

  test("an authenticator code accepted on one server is refused on the other", () => {
    const [old, next] = servers.map((server) =>
      GuessBudgets.durable(server.db),
    );
    if (!old || !next) throw new Error("two servers");
    expect(old.codes.spend("account:123456", 91_000, 1_000)).toBe(true);
    expect(next.codes.spend("account:123456", 91_000, 2_000)).toBe(false);
    // A code whose verification failed is given back.
    old.codes.unspend("account:123456");
    expect(next.codes.spend("account:123456", 91_000, 2_000)).toBe(true);
    // Once it could no longer be valid, it is forgotten.
    expect(old.codes.spend("account:123456", 200_000, 95_000)).toBe(true);
  });

  test("an account's password budget is counted once for every server", () => {
    const rule = { limit: 2, windowMs: 60_000 };
    const [old, next] = servers.map((server) =>
      GuessBudgets.durable(server.db).limiter("password-account", rule),
    );
    if (!old || !next) throw new Error("two servers");
    expect(old.consume("owner@example.test", 1_000).allowed).toBe(true);
    expect(next.consume("owner@example.test", 1_000).allowed).toBe(true);
    expect(old.consume("owner@example.test", 1_000).allowed).toBe(false);
  });
});
