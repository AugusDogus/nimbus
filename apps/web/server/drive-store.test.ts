import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import type { Database as SQLite } from "bun:sqlite";
import type { DriveStore } from "@nimbus/api/drive-store";
import { createDriveStore } from "./drive-store";
import { createTestDatabase } from "./db/testing";

let client: SQLite;
let store: DriveStore;

beforeEach(() => {
  const opened = createTestDatabase();
  client = opened.sqlite;
  client.run(
    "INSERT INTO user (id, name, email, role) VALUES ('owner', 'Owner', 'owner@example.test', 'admin'), ('reader', 'Reader', 'reader@example.test', 'user')",
  );
  store = createDriveStore(opened.db);
});
afterEach(() => {
  client.close();
});

const share = (id: string, path: string) => ({
  id,
  token: `token-${id}`,
  path,
  createdBy: "owner",
  createdAt: 1,
  expiresAt: null,
  passwordHash: null,
  downloadCount: 0,
  maxDownloads: null,
  mode: "download" as const,
});
const grant = (id: string, path: string) => ({
  id,
  path,
  subject: { type: "user" as const, id: "reader" },
  permission: "read" as const,
});
const paths = async () => ({
  grants: (await store.grantsForUser("reader")).map((row) => row.path).sort(),
  shares: (await store.listShares("owner")).map((row) => row.path).sort(),
  bookmarks: (await store.listBookmarks("reader"))
    .map((row) => row.path)
    .sort(),
});

test("movePath rewrites records at and under the source, treating SQL wildcards and sibling prefixes literally", async () => {
  for (const [index, path] of [
    "a_%",
    "a_%/child 😀/x",
    "a_%b",
    "aX%",
    "other",
  ].entries()) {
    await store.saveGrant(grant(`g${index}`, path));
    await store.createShare(share(`s${index}`, path));
    await store.saveBookmark("reader", {
      path,
      starred: true,
      accessedAt: 1,
      visits: 1,
    });
  }
  await store.movePath("a_%", "moved/😀 b");
  const expected = [
    "aX%",
    "a_%b",
    "moved/😀 b",
    "moved/😀 b/child 😀/x",
    "other",
  ];
  expect(await paths()).toEqual({
    grants: expected,
    shares: expected,
    bookmarks: expected,
  });
});

test("movePath drops records left at the vacant destination instead of attaching them to arriving content", async () => {
  await store.saveGrant(grant("stale", "target"));
  await store.saveGrant(grant("stale-child", "target/old"));
  await store.createShare(share("stale", "target"));
  await store.saveBookmark("reader", {
    path: "target",
    starred: true,
    accessedAt: 1,
    visits: 1,
  });
  await store.saveGrant(grant("moving", "source"));
  await store.movePath("source", "target");
  expect((await store.grantsForUser("reader")).map((row) => row.id)).toEqual([
    "moving",
  ]);
  expect(await store.listShares("owner")).toEqual([]);
  expect(await store.listBookmarks("reader")).toEqual([]);
});

test("trash detaches records, hides them from listings, and restores them with the item", async () => {
  await store.saveGrant(grant("inside", "docs/report.txt"));
  await store.saveGrant(grant("outside", "docs-old"));
  await store.createShare({
    ...share("inside", "docs"),
    passwordHash: "secret-hash",
  });
  await store.saveBookmark("reader", {
    path: "docs",
    starred: true,
    accessedAt: 5,
    visits: 1,
  });
  const item = {
    id: "trash-1",
    path: "docs",
    deletedBy: "owner",
    deletedAt: 1,
    expiresAt: 2,
  };
  await store.addTrash(item);
  expect(await paths()).toEqual({
    grants: ["docs-old"],
    shares: [],
    bookmarks: [],
  });
  expect(await store.getShare("token-inside")).toBeNull();
  expect(await store.listTrash(null)).toEqual([item]);
  expect(await store.getTrash("trash-1")).toEqual(item);
  // A grant created at the vacant path while the item was in trash must not survive restoration.
  await store.saveGrant({ ...grant("intruder", "docs"), permission: "admin" });
  await store.restoreTrash("trash-1");
  expect(await store.listTrash(null)).toEqual([]);
  expect(await paths()).toEqual({
    grants: ["docs-old", "docs/report.txt"],
    shares: ["docs"],
    bookmarks: ["docs"],
  });
  expect((await store.getShare("token-inside"))?.passwordHash).toBe(
    "secret-hash",
  );
  expect(await store.listBookmarks("reader")).toMatchObject([
    { path: "docs", starred: true, accessedAt: 5, visits: 1 },
  ]);
});

test("restoring skips records whose account or group was removed while the item was in trash", async () => {
  client.run(
    "INSERT INTO user (id, name, email) VALUES ('gone', 'Gone', 'gone@example.test')",
  );
  await store.saveGroup({ id: "team", name: "Team", memberIds: ["reader"] });
  await store.saveGrant({
    ...grant("group", "docs"),
    subject: { type: "group", id: "team" },
  });
  await store.saveGrant({
    ...grant("user", "docs"),
    subject: { type: "user", id: "gone" },
  });
  await store.createShare({ ...share("gone", "docs"), createdBy: "gone" });
  await store.saveBookmark("gone", {
    path: "docs",
    starred: true,
    accessedAt: 1,
    visits: 1,
  });
  await store.addTrash({
    id: "trash-2",
    path: "docs",
    deletedBy: "owner",
    deletedAt: 1,
    expiresAt: 2,
  });
  client.run("DELETE FROM user WHERE id = 'gone'");
  await store.removeGroup("team");
  await store.restoreTrash("trash-2");
  expect(await store.grantsForPath("docs")).toEqual([]);
  expect(await store.getShare("token-gone")).toBeNull();
});

test("removing trash discards its detached records", async () => {
  await store.createShare(share("purged", "file.txt"));
  await store.addTrash({
    id: "trash-3",
    path: "file.txt",
    deletedBy: "owner",
    deletedAt: 1,
    expiresAt: 2,
  });
  await store.removeTrash("trash-3");
  await store.restoreTrash("trash-3");
  expect(await store.getShare("token-purged")).toBeNull();
});

test("dead properties follow moves, survive trash and restore, and are copied", async () => {
  const property = (name: string) => ({
    namespace: "urn:test",
    name,
    xml: `<${name} xmlns="urn:test">1</${name}>`,
  });
  await store.patchDavProperties("docs", [property("a")], []);
  await store.patchDavProperties(
    "docs/file.txt",
    [property("b"), property("c")],
    [],
  );
  await store.patchDavProperties(
    "docs/file.txt",
    [{ ...property("b"), xml: '<b xmlns="urn:test">2</b>' }],
    [{ namespace: "urn:test", name: "c" }],
  );
  await store.movePath("docs", "moved");
  const moved = await store.davProperties(["docs", "moved", "moved/file.txt"]);
  expect([...moved.keys()].sort()).toEqual(["moved", "moved/file.txt"]);
  expect(moved.get("moved/file.txt")).toEqual([
    { namespace: "urn:test", name: "b", xml: '<b xmlns="urn:test">2</b>' },
  ]);
  await store.copyDavProperties("moved", "copy");
  expect(
    (await store.davProperties(["copy/file.txt"])).get("copy/file.txt"),
  ).toHaveLength(1);
  await store.addTrash({
    id: "trash-4",
    path: "moved",
    deletedBy: "owner",
    deletedAt: 1,
    expiresAt: 2,
  });
  expect((await store.davProperties(["moved", "moved/file.txt"])).size).toBe(0);
  await store.restoreTrash("trash-4");
  expect((await store.davProperties(["moved", "moved/file.txt"])).size).toBe(2);
});

test("concurrent download claims never exceed the link's limit", async () => {
  await store.createShare({ ...share("limited", "docs"), maxDownloads: 2 });
  const claims = await Promise.all(
    Array.from({ length: 5 }, () => store.claimDownload("limited")),
  );
  expect(claims.filter(Boolean)).toHaveLength(2);
  expect((await store.getShare("token-limited"))?.downloadCount).toBe(2);
});

test("a refunded claim frees one download, and claims racing refunds never exceed the limit", async () => {
  await store.createShare({ ...share("limited", "docs"), maxDownloads: 1 });
  const count = async () =>
    (await store.getShare("token-limited"))?.downloadCount;
  expect(await store.claimDownload("limited")).toBe(true);
  expect(await store.claimDownload("limited")).toBe(false);
  await store.refundDownload("limited");
  expect(await count()).toBe(0);
  // Each round: the holder refunds while others race to claim; at most one claim may stand.
  for (let round = 0; round < 20; round++) {
    expect(await store.claimDownload("limited")).toBe(true);
    const [, ...claims] = await Promise.all([
      store.refundDownload("limited"),
      ...Array.from({ length: 4 }, () => store.claimDownload("limited")),
    ]);
    expect(claims.filter(Boolean).length).toBeLessThanOrEqual(1);
    expect(await count()).toBe(claims.filter(Boolean).length);
    if (claims.some(Boolean)) await store.refundDownload("limited");
  }
  // Never below zero, even refunded without a claim held.
  await store.refundDownload("limited");
  expect(await count()).toBe(0);
});

test("only a link's creator can change its settings", async () => {
  await store.createShare({ ...share("limited", "docs"), maxDownloads: 2 });
  const settings = {
    expiresAt: 5000,
    passwordHash: null,
    maxDownloads: null,
    mode: "view" as const,
  };
  expect(await store.updateShare("limited", "reader", settings)).toBeNull();
  expect((await store.getShare("token-limited"))?.mode).toBe("download");
  expect(await store.updateShare("limited", "owner", settings)).toMatchObject(
    settings,
  );
  expect(await store.claimDownload("limited")).toBe(true);
});

test("a link restored from trash keeps its download limit, count and preview-only mode", async () => {
  await store.createShare({
    ...share("limited", "docs"),
    maxDownloads: 3,
    mode: "view",
  });
  expect(await store.claimDownload("limited")).toBe(true);
  await store.addTrash({
    id: "trash-limits",
    path: "docs",
    deletedBy: "owner",
    deletedAt: 1,
    expiresAt: 2,
  });
  await store.restoreTrash("trash-limits");
  expect(await store.getShare("token-limited")).toMatchObject({
    maxDownloads: 3,
    downloadCount: 1,
    mode: "view",
  });
});

const fileRequest = (id: string, path: string) => ({
  id,
  token: `request-${id}`,
  path,
  createdBy: "owner",
  createdAt: 1,
  expiresAt: null,
  passwordHash: null,
  note: null,
  maxFileBytes: null,
  maxFiles: 5,
  maxTotalBytes: null,
});

test("file requests follow their folder through moves, and trash suspends them with their upload ledger", async () => {
  await store.fileRequests.create(fileRequest("inbox", "docs/inbox"));
  await store.fileRequests.reserve(
    {
      id: "upload-1",
      requestId: "inbox",
      uploaderHash: "browser",
      size: 10,
      createdAt: 1,
    },
    { activeSince: 0, maxActive: 5, maxPendingBytes: null },
  );
  await store.fileRequests.finishUpload("upload-1", "docs/inbox/a.txt", 2);
  await store.movePath("docs", "moved");
  expect((await store.fileRequests.getByToken("request-inbox"))?.path).toBe(
    "moved/inbox",
  );
  await store.addTrash({
    id: "trash-requests",
    path: "moved",
    deletedBy: "owner",
    deletedAt: 1,
    expiresAt: 2,
  });
  expect(await store.fileRequests.getByToken("request-inbox")).toBeNull();
  // A request created at the vacant path while the folder was in trash is not kept on restore.
  await store.fileRequests.create(fileRequest("intruder", "moved/inbox"));
  await store.restoreTrash("trash-requests");
  expect((await store.fileRequests.getByToken("request-inbox"))?.path).toBe(
    "moved/inbox",
  );
  expect(await store.fileRequests.getByToken("request-intruder")).toBeNull();
  expect(await store.fileRequests.usage("inbox", 0)).toEqual({
    files: 1,
    bytes: 10,
  });
});

test("file requests are discarded with content merged into another item, and with trash", async () => {
  await store.fileRequests.create(fileRequest("merged", "merged"));
  await store.claimVacant("merged");
  expect(await store.fileRequests.getByToken("request-merged")).toBeNull();
  await store.fileRequests.create(fileRequest("purged", "purged"));
  await store.addTrash({
    id: "trash-purged",
    path: "purged",
    deletedBy: "owner",
    deletedAt: 1,
    expiresAt: 2,
  });
  await store.removeTrash("trash-purged");
  await store.restoreTrash("trash-purged");
  expect(await store.fileRequests.getByToken("request-purged")).toBeNull();
});

test("trash rows saved without file requests still restore", async () => {
  await store.createShare(share("legacy", "legacy"));
  await store.addTrash({
    id: "trash-legacy",
    path: "legacy",
    deletedBy: "owner",
    deletedAt: 1,
    expiresAt: 2,
  });
  client.run(
    `UPDATE nimbus_trash SET detached_access = json_remove(detached_access, '$.fileRequests') WHERE id = 'trash-legacy'`,
  );
  await store.restoreTrash("trash-legacy");
  expect((await store.getShare("token-legacy"))?.path).toBe("legacy");
});

const version = (id: string, path: string) => ({
  id,
  path,
  name: path.split("/").at(-1) ?? path,
  size: 1,
  modifiedAt: 1,
  archivedAt: 1,
  archivedBy: null,
});
const historyPaths = async () =>
  (await store.versions.archivedBefore(Number.MAX_SAFE_INTEGER))
    .map((row) => row.path)
    .sort();

test("file history moves with its file on rename, trash and restore, in the same transactions as links", async () => {
  const ids = [
    "a1b2c3d4-0000-4000-8000-000000000001",
    "a1b2c3d4-0000-4000-8000-000000000002",
    "a1b2c3d4-0000-4000-8000-000000000003",
    "a1b2c3d4-0000-4000-8000-000000000004",
  ];
  await store.versions.add(version(ids[0] ?? "", "a_%/report 😀.txt"));
  await store.versions.add(version(ids[1] ?? "", "a_%"));
  await store.versions.add(version(ids[2] ?? "", "a_%b/other.txt"));
  // Left at the destination by a file removed outside Nimbus.
  await store.versions.add(version(ids[3] ?? "", "moved/report 😀.txt"));
  await store.movePath("a_%", "moved");
  expect(await historyPaths()).toEqual([
    "a_%b/other.txt",
    "moved",
    "moved/report 😀.txt",
  ]);
  expect(
    (await store.versions.list("moved/report 😀.txt")).map((row) => row.id),
  ).toEqual([ids[0]]);
  await store.addTrash({
    id: "trash-v",
    path: "moved",
    deletedBy: "owner",
    deletedAt: 1,
    expiresAt: 2,
  });
  expect(await historyPaths()).toEqual([
    ".nimbus/trash/trash-v",
    ".nimbus/trash/trash-v/report 😀.txt",
    "a_%b/other.txt",
  ]);
  // History recorded at the vacant path while the item was in trash does not survive restoration.
  await store.versions.add(
    version("b1b2c3d4-0000-4000-8000-000000000005", "moved/report 😀.txt"),
  );
  await store.restoreTrash("trash-v");
  expect(await historyPaths()).toEqual([
    "a_%b/other.txt",
    "moved",
    "moved/report 😀.txt",
  ]);
  expect(
    (await store.versions.removeAt("moved")).map((row) => row.path).sort(),
  ).toEqual(["moved", "moved/report 😀.txt"]);
  expect(await historyPaths()).toEqual(["a_%b/other.txt"]);
});

test("path prefix matches use the path indexes", async () => {
  for (const [table, index] of [
    ["nimbus_file_version", "nimbus_file_version_path"],
    ["nimbus_grant", "nimbus_grant_path"],
    ["nimbus_share", "nimbus_share_path"],
    ["nimbus_bookmark", "nimbus_bookmark_path"],
    ["nimbus_file_request", "nimbus_file_request_path"],
  ] as const) {
    const plan = client
      .query<{ detail: string }, [string, string, string]>(
        `EXPLAIN QUERY PLAN SELECT * FROM ${table} WHERE path = ? OR (path >= ? AND path < ?)`,
      )
      .all("docs", "docs/", "docs0");
    expect(plan.map((row) => row.detail).join("\n")).toContain(index);
  }
});

test("concurrent writes and transactions all commit", async () => {
  // With an asynchronous driver, overlapping transactions failed with SQLITE_BUSY.
  const results = await Promise.allSettled([
    store.saveGroup({ id: "one", name: "One", memberIds: ["reader"] }),
    store.saveGroup({ id: "two", name: "Two", memberIds: ["reader"] }),
    store.saveGrant(grant("during", "docs")),
    store.movePath("docs", "papers"),
    store.saveBookmark("reader", {
      path: "x",
      starred: true,
      accessedAt: 1,
      visits: 1,
    }),
  ]);
  expect(results.map((result) => result.status)).toEqual(
    Array.from({ length: 5 }, () => "fulfilled"),
  );
  expect((await store.listGroups()).map((group) => group.id).sort()).toEqual([
    "one",
    "two",
  ]);
});

test("the access epoch changes with every grant, group, membership and account change, whoever writes it", async () => {
  const changes: [string, () => Promise<unknown> | unknown][] = [
    ["grant saved", () => store.saveGrant(grant("e1", "docs"))],
    ["grant moved", () => store.movePath("docs", "papers")],
    ["grant removed", () => store.removeGrant("e1")],
    [
      "group saved",
      () => store.saveGroup({ id: "t", name: "T", memberIds: ["reader"] }),
    ],
    [
      "membership removed by sign-in sync",
      () =>
        client.run("DELETE FROM nimbus_group_member WHERE user_id = 'reader'"),
    ],
    ["group removed", () => store.removeGroup("t")],
    [
      "account disabled by Better Auth",
      () => client.run("UPDATE user SET banned = 1 WHERE id = 'reader'"),
    ],
    [
      "account removed",
      () => client.run("DELETE FROM user WHERE id = 'reader'"),
    ],
  ];
  for (const [name, change] of changes) {
    const before = await store.accessEpoch();
    await change();
    expect({ name, changed: (await store.accessEpoch()) !== before }).toEqual({
      name,
      changed: true,
    });
  }
  const steady = await store.accessEpoch();
  await store.createShare(share("unrelated", "docs"));
  await store.saveBookmark("owner", {
    path: "docs",
    starred: true,
    accessedAt: 1,
    visits: 1,
  });
  expect(await store.accessEpoch()).toBe(steady);
});

test("cached access follows revoked grants and disabled accounts on the next request", async () => {
  const { getAccess } = await import("@nimbus/api/access");
  await store.saveGrant(grant("read-docs", "docs"));
  expect((await getAccess(store, "reader")).can("docs/a.txt", "read")).toBe(
    true,
  );
  // Unchanged epoch: the same access object is reused.
  expect(await getAccess(store, "reader")).toBe(
    await getAccess(store, "reader"),
  );
  await store.removeGrant("read-docs");
  expect((await getAccess(store, "reader")).can("docs/a.txt", "read")).toBe(
    false,
  );
  await store.saveGrant(grant("read-docs", "docs"));
  await getAccess(store, "reader");
  client.run("UPDATE user SET banned = 1 WHERE id = 'reader'");
  await expect(getAccess(store, "reader")).rejects.toMatchObject({
    code: "UNAUTHORIZED",
  });
});

test("shared paths list each live path with sharing once, by kind, without trashed records", async () => {
  expect(await store.sharedPaths()).toEqual({
    grants: [],
    links: [],
    fileRequests: [],
    bookmarks: [],
  });
  await store.saveGrant(grant("root", ""));
  await store.saveGrant(grant("team", "team"));
  await store.createShare(share("link", "team/users"));
  await store.fileRequests.create(fileRequest("drop", "team/users"));
  for (const userId of ["owner", "reader"])
    await store.saveBookmark(userId, {
      path: "team/users/a",
      starred: false,
      accessedAt: 1,
      visits: 1,
    });
  await store.createShare(share("trashed", "old"));
  await store.addTrash({
    id: "trash-old",
    path: "old",
    deletedBy: "owner",
    deletedAt: 1,
    expiresAt: 2,
  });
  const shared = await store.sharedPaths();
  expect({ ...shared, grants: [...shared.grants].sort() }).toEqual({
    grants: ["", "team"],
    links: ["team/users"],
    fileRequests: ["team/users"],
    bookmarks: ["team/users/a"],
  });
});

test("home containers are recorded once and can be forgotten", async () => {
  expect(await store.listHomeContainers()).toEqual([]);
  await store.addHomeContainer("users");
  await expect(store.addHomeContainer("users")).rejects.toThrow();
  await store.addHomeContainer("team/people");
  expect((await store.listHomeContainers()).sort()).toEqual([
    "team/people",
    "users",
  ]);
  await store.removeHomeContainer("users");
  expect(await store.listHomeContainers()).toEqual(["team/people"]);
});

test("records opens and stars of a bookmark in one statement each", async () => {
  await store.recordBookmark("reader", "docs/a.txt", { type: "open" }, 10);
  await Promise.all(
    Array.from({ length: 10 }, (_, at) =>
      store.recordBookmark("reader", "docs/a.txt", { type: "open" }, 20 + at),
    ),
  );
  await store.recordBookmark(
    "reader",
    "docs/a.txt",
    { type: "star", starred: true },
    99,
  );
  // Starring a path never opened makes a bookmark with no visits.
  await store.recordBookmark(
    "reader",
    "docs/b.txt",
    { type: "star", starred: true },
    50,
  );
  expect(
    (await store.listBookmarks("reader"))
      .map(({ path, starred, accessedAt, visits }) => ({
        path,
        starred,
        accessedAt,
        visits,
      }))
      .sort((a, b) => a.path.localeCompare(b.path)),
  ).toEqual([
    { path: "docs/a.txt", starred: true, accessedAt: 29, visits: 11 },
    { path: "docs/b.txt", starred: true, accessedAt: 50, visits: 0 },
  ]);
});

const day = 24 * 60 * 60 * 1000;
const revokedRows = () =>
  client
    .query<{ owner: string }, []>("SELECT owner FROM nimbus_revoked_share")
    .all();

test("a revoked link reads as turned off for 90 days, then as unknown, and is pruned", async () => {
  setSystemTime(new Date(1_000 * day));
  await store.createShare(share("old", "a"));
  await store.revokeShare("old", "owner");
  expect(await store.wasShareRevoked("token-old")).toBe(true);
  expect(await store.wasShareRevoked("token-never")).toBe(false);

  setSystemTime(new Date(1_090 * day + 1));
  // Past 90 days it reads as unknown even before anything prunes it.
  expect(await store.wasShareRevoked("token-old")).toBe(false);
  expect(revokedRows()).toHaveLength(1);
  // The next revoke prunes it, and so does the retention job.
  await store.createShare(share("next", "b"));
  await store.revokeShare("next", "owner");
  expect(revokedRows()).toHaveLength(1);
  setSystemTime(new Date(1_181 * day));
  await store.pruneRevokedShares(Date.now());
  expect(revokedRows()).toHaveLength(0);
  setSystemTime();
});

test("an owner keeps at most the 1,000 most recent revoked links", async () => {
  for (let index = 0; index < 1_003; index++) {
    setSystemTime(new Date(1_000 * day + index));
    await store.createShare(share(`s${index}`, `p${index}`));
    await store.revokeShare(`s${index}`, "owner");
  }
  setSystemTime(new Date(1_000 * day + 1_003));
  await store.createShare({ ...share("theirs", "q"), createdBy: "reader" });
  await store.revokeShare("theirs", "reader");
  expect(revokedRows().filter((row) => row.owner === "owner")).toHaveLength(
    1_000,
  );
  expect(revokedRows().filter((row) => row.owner === "reader")).toHaveLength(1);
  expect(await store.wasShareRevoked("token-s0")).toBe(false);
  expect(await store.wasShareRevoked("token-s2")).toBe(false);
  expect(await store.wasShareRevoked("token-s3")).toBe(true);
  expect(await store.wasShareRevoked("token-s1002")).toBe(true);
  setSystemTime();
});
