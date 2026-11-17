import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { appRouter } from "./routers";
import { crawlingSearchService, createTestDriveStore } from "./testing";
import { provideSearchService } from "./search-service";
import {
  flushAudit,
  resetAuditForTest,
  setAuditSink,
  type RecordedAuditEvent,
} from "./audit";
import { FileVersions } from "./file-versions";
import { FileListing } from "./file-listing";

// bun-types declares asymmetric matchers as returning any; typing it unknown keeps any out of the assertions.
const anyString: unknown = expect.any(String);

describe("drive workflows", () => {
  let root: string;
  let previousRoot: string | undefined;
  let memory: ReturnType<typeof createTestDriveStore>;
  const caller = (id = "user-1") =>
    appRouter.createCaller({
      headers: new Headers(),
      session: { user: { id } },
      sessionStillValid: async () => true,
      drive: memory.store,
      preferences: {
        getUserPreferences: async () => null,
        setUserPreferences: async (_id, value) => value,
      },
    });
  beforeEach(async () => {
    previousRoot = process.env.NIMBUS_DATA_ROOT;
    root = await mkdtemp(path.join(os.tmpdir(), "nimbus-drive-"));
    process.env.NIMBUS_DATA_ROOT = root;
    provideSearchService(crawlingSearchService(root));
    memory = createTestDriveStore();
    await mkdir(path.join(root, "docs"));
    await writeFile(path.join(root, "docs", "report.txt"), "report");
    await writeFile(path.join(root, "private.txt"), "private");
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    if (previousRoot === undefined) delete process.env.NIMBUS_DATA_ROOT;
    else process.env.NIMBUS_DATA_ROOT = previousRoot;
  });
  it("prevents all mutations of the drive root", async () => {
    await expect(caller().files.delete({ path: "" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await expect(
      caller().files.rename({ path: ".", newName: "renamed" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      caller().files.move({ sourcePath: "", destinationPath: "docs" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect((await stat(root)).isDirectory()).toBe(true);
  });
  it("rejects reserved, blank, and traversal filenames", async () => {
    for (const name of [
      " ",
      ".nimbus",
      "../escape",
      "folder/file",
      "bad\0name",
    ])
      await expect(caller().files.createFolder({ name })).rejects.toMatchObject(
        { code: "BAD_REQUEST" },
      );
  });
  it("grants folder access without exposing siblings, and revokes cached access immediately", async () => {
    await caller().access.grant({
      path: "docs",
      subject: { type: "user", id: "reader" },
      permission: "read",
    });
    expect(
      FileListing.entries(await caller("reader").files.list({})).map(
        (entry) => entry.name,
      ),
    ).toEqual(["docs"]);
    expect(
      FileListing.entries(
        await caller("reader").files.list({ path: "docs" }),
      )[0]?.name,
    ).toBe("report.txt");
    await expect(
      caller("reader").files.delete({ path: "docs/report.txt" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const [grant] = await caller().access.permissions({ path: "docs" });
    if (!grant) throw new Error("Expected a grant");
    await caller().access.revoke({ path: "docs", id: grant.id });
    await expect(
      caller("reader").files.list({ path: "docs" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("lists accounts only to callers who can manage sharing for the path", async () => {
    await expect(
      caller("reader").access.people({ path: "docs" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await caller().access.grant({
      path: "docs",
      subject: { type: "user", id: "reader" },
      permission: "admin",
    });
    expect(await caller("reader").access.people({ path: "docs" })).toEqual([
      { id: "user-1", name: "Owner", email: "owner@example.test" },
      { id: "reader", name: "Reader", email: "reader@example.test" },
    ]);
    await expect(
      caller("reader").access.people({ path: "private.txt" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("records who granted, revoked, shared, and trashed", async () => {
    resetAuditForTest();
    const events: RecordedAuditEvent[] = [];
    setAuditSink(async (batch) => void events.push(...batch));
    try {
      await caller().access.grant({
        path: "docs",
        subject: { type: "user", id: "reader" },
        permission: "read",
      });
      const [grant] = await caller().access.permissions({ path: "docs" });
      if (!grant) throw new Error("Expected a grant");
      await caller().access.revoke({ path: "docs", id: grant.id });
      await caller().shares.create({
        path: "docs",
        expiresAt: null,
        password: "test-password",
      });
      await caller().files.delete({ path: "private.txt" });
      await flushAudit();
      // toMatchObject accepts the unknown-typed matcher; every mapped event has exactly these keys.
      expect(
        events.map(({ action, actor, target }) => ({
          action,
          actor,
          target: target?.id,
        })),
      ).toMatchObject([
        {
          action: "grant.added",
          actor: { type: "user", id: "user-1", label: "owner@example.test" },
          target: "docs",
        },
        {
          action: "grant.removed",
          actor: { type: "user", id: "user-1", label: "owner@example.test" },
          target: "docs",
        },
        {
          action: "share.created",
          actor: { type: "user", id: "user-1", label: "owner@example.test" },
          target: anyString,
        },
        {
          action: "trash.moved",
          actor: { type: "user", id: "user-1", label: "owner@example.test" },
          target: "private.txt",
        },
      ]);
      expect(JSON.stringify(events)).not.toContain("test-password");
    } finally {
      resetAuditForTest();
    }
  });
  it("records link edits, file requests, version restores, and emptied trash", async () => {
    resetAuditForTest();
    const events: RecordedAuditEvent[] = [];
    setAuditSink(async (batch) => void events.push(...batch));
    try {
      await caller().shares.create({ path: "docs", expiresAt: null });
      const [share] = await caller().shares.list();
      if (!share) throw new Error("Expected a share");
      await caller().shares.update({
        id: share.id,
        expiresAt: null,
        maxDownloads: 3,
        mode: "view",
        password: { kind: "set", value: "link-password" },
      });
      await caller().fileRequests.create({
        path: "docs",
        note: null,
        expiresAt: null,
        maxFileBytes: null,
        maxFiles: null,
        maxTotalBytes: null,
        password: "request-password",
      });
      const [request] = await caller().fileRequests.list();
      if (!request) throw new Error("Expected a file request");
      await caller().fileRequests.update({
        id: request.id,
        note: "Forms",
        expiresAt: null,
        maxFileBytes: null,
        maxFiles: 2,
        maxTotalBytes: null,
        password: { kind: "keep" },
      });
      await caller().fileRequests.revoke({ id: request.id });
      await writeFile(path.join(root, "incoming.txt"), "second draft");
      await FileVersions.commitReplacement({
        store: memory.store.versions,
        dataRoot: root,
        path: "docs/report.txt",
        incoming: path.join(root, "incoming.txt"),
        archivedBy: "user-1",
      });
      const [version] = await caller().versions.list({
        path: "docs/report.txt",
      });
      if (!version) throw new Error("Expected a version");
      await caller().versions.restore({
        path: "docs/report.txt",
        id: version.id,
      });
      await caller().files.delete({ path: "private.txt" });
      await caller().trash.empty();
      await flushAudit();
      expect(
        events.map(({ action, target }) => ({
          action,
          target: target?.type ?? null,
        })),
      ).toEqual([
        { action: "share.created", target: "share" },
        { action: "share.updated", target: "share" },
        { action: "file_request.created", target: "file_request" },
        { action: "file_request.updated", target: "file_request" },
        { action: "file_request.revoked", target: "file_request" },
        { action: "version.restored", target: "path" },
        { action: "trash.moved", target: "path" },
        { action: "trash.purged", target: "path" },
        { action: "trash.emptied", target: null },
      ]);
      expect(JSON.stringify(events)).not.toContain("link-password");
      expect(JSON.stringify(events)).not.toContain("request-password");
    } finally {
      resetAuditForTest();
    }
  });
  it("resolves group permissions and removes access with membership", async () => {
    await caller().access.saveGroup({ name: "Team", memberIds: ["reader"] });
    const [group] = await caller().access.groups();
    if (!group) throw new Error("Expected a group");
    await caller().access.grant({
      path: "docs",
      subject: { type: "group", id: group.id },
      permission: "write",
    });
    await caller("reader").files.createFolder({ path: "docs", name: "notes" });
    await caller().access.saveGroup({ ...group, memberIds: [] });
    await expect(
      caller("reader").files.createFolder({ path: "docs", name: "private" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("trashes and restores content without overwriting existing files", async () => {
    await caller().files.delete({ path: "docs/report.txt" });
    const [item] = await caller().trash.list();
    if (!item) throw new Error("Expected a trash item");
    await writeFile(path.join(root, "docs/report.txt"), "replacement");
    await expect(caller().trash.restore({ id: item.id })).rejects.toMatchObject(
      { code: "CONFLICT" },
    );
    expect(await readFile(path.join(root, "docs/report.txt"), "utf8")).toBe(
      "replacement",
    );
    await rm(path.join(root, "docs/report.txt"));
    await caller().trash.restore({ id: item.id });
    expect(await readFile(path.join(root, "docs/report.txt"), "utf8")).toBe(
      "report",
    );
    expect(await caller().trash.list()).toEqual([]);
  });
  it("keeps links, direct grants, and stars on renamed items", async () => {
    const moved = await caller().shares.create({
      path: "docs/report.txt",
      expiresAt: null,
      password: "test-password",
    });
    const kept = await caller().shares.create({
      path: "private.txt",
      expiresAt: null,
    });
    await caller().access.grant({
      path: "docs/report.txt",
      subject: { type: "user", id: "reader" },
      permission: "read",
    });
    await caller().catalog.bookmark({ path: "docs/report.txt", starred: true });
    await caller().files.rename({
      path: "docs/report.txt",
      newName: "renamed.txt",
    });
    expect((await memory.store.getShare(moved.token))?.path).toBe(
      "docs/renamed.txt",
    );
    expect((await memory.store.getShare(kept.token))?.path).toBe("private.txt");
    expect(
      (await caller("reader").catalog.shared()).map((entry) => entry.path),
    ).toEqual(["docs/renamed.txt"]);
    expect(
      (await caller().catalog.bookmarks()).map((entry) => [
        entry.path,
        entry.starred,
      ]),
    ).toEqual([["docs/renamed.txt", true]]);
  });
  it("counts each open of a bookmarked item, but not starring it", async () => {
    await caller().catalog.bookmark({ path: "docs/report.txt" });
    await caller().catalog.bookmark({ path: "docs/report.txt" });
    await caller().catalog.bookmark({ path: "docs/report.txt", starred: true });
    expect(await memory.store.listBookmarks("user-1")).toMatchObject([
      { path: "docs/report.txt", starred: true, visits: 2 },
    ]);
  });

  it("moves descendant grants with a folder while the destination's inherited access replaces the source's", async () => {
    await mkdir(path.join(root, "archive"));
    await caller().access.grant({
      path: "docs",
      subject: { type: "user", id: "reader" },
      permission: "read",
    });
    await mkdir(path.join(root, "docs", "team"));
    await caller().access.grant({
      path: "docs/team",
      subject: { type: "user", id: "reader" },
      permission: "write",
    });
    await caller().files.move({
      sourcePath: "docs/report.txt",
      destinationPath: "archive",
    });
    // Read access inherited from the source folder does not follow the file.
    await expect(
      caller("reader").files.list({ path: "archive" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await caller().files.move({
      sourcePath: "docs",
      destinationPath: "archive",
    });
    // Direct grants on the moved folder and its descendants travel with it.
    await caller("reader").files.createFolder({
      path: "archive/docs/team",
      name: "notes",
    });
    expect(
      FileListing.entries(
        await caller("reader").files.list({ path: "archive/docs" }),
      ).map((entry) => entry.name),
    ).toEqual(["team"]);
    expect(
      (await caller().access.permissions({ path: "archive/docs/team" })).map(
        (grant) => grant.permission,
      ),
    ).toEqual(["write"]);
    expect(await caller().access.permissions({ path: "docs" })).toEqual([]);
  });
  it("does not let records left at a vacant destination attach to arriving content", async () => {
    await caller().access.grant({
      path: "private.txt",
      subject: { type: "user", id: "reader" },
      permission: "read",
    });
    await rm(path.join(root, "private.txt")); // Deleted outside Nimbus, leaving a stale grant.
    await caller().files.move({
      sourcePath: "docs/report.txt",
      destinationPath: "",
    });
    await caller().files.rename({ path: "report.txt", newName: "private.txt" });
    expect(
      FileListing.entries(await caller("reader").files.list({ path: "" })),
    ).toEqual([]);
  });
  it("detaches sharing while an item is in trash and restores it with the item", async () => {
    const link = await caller().shares.create({
      path: "docs",
      expiresAt: null,
    });
    await caller().access.grant({
      path: "docs/report.txt",
      subject: { type: "user", id: "reader" },
      permission: "read",
    });
    await caller().catalog.bookmark({ path: "docs", starred: true });
    await caller().files.delete({ path: "docs" });
    expect(await memory.store.getShare(link.token)).toBeNull();
    expect(await caller("reader").catalog.shared()).toEqual([]);
    expect(await caller().catalog.bookmarks()).toEqual([]);
    const [item] = await caller().trash.list();
    if (!item) throw new Error("Expected a trash item");
    expect(JSON.stringify(item)).not.toContain(link.token);
    await caller().trash.restore({ id: item.id });
    expect((await memory.store.getShare(link.token))?.path).toBe("docs");
    expect(
      (await caller("reader").catalog.shared()).map((entry) => entry.path),
    ).toEqual(["docs/report.txt"]);
    expect(
      (await caller().catalog.bookmarks()).map((entry) => entry.path),
    ).toEqual(["docs"]);
  });
  it("discards detached sharing when trash is permanently deleted", async () => {
    const link = await caller().shares.create({
      path: "private.txt",
      expiresAt: null,
    });
    await caller().files.delete({ path: "private.txt" });
    const [item] = await caller().trash.list();
    if (!item) throw new Error("Expected a trash item");
    await caller().trash.purge({ id: item.id });
    await writeFile(path.join(root, "private.txt"), "new content");
    expect(await memory.store.getShare(link.token)).toBeNull();
  });
  it("searches under a folder the caller may not read without looking at it", async () => {
    await caller().access.grant({
      path: "docs",
      subject: { type: "user", id: "reader" },
      permission: "read",
    });
    await mkdir(path.join(root, "vault"));
    await symlink(root, path.join(root, "vault", "link"));
    for (const folder of ["vault/link/inner", "vault/missing", "nowhere"])
      expect(
        await caller("reader").catalog.search({
          query: "report",
          path: folder,
        }),
      ).toMatchObject({ entries: [], total: 0 });
    // The owner still gets the usual answer for a symlink in the path.
    await expect(
      caller().catalog.search({ query: "report", path: "vault/link/inner" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("searches only accessible files and keeps password hashes out of API responses", async () => {
    await caller().access.grant({
      path: "docs",
      subject: { type: "user", id: "reader" },
      permission: "read",
    });
    expect(
      (
        await caller("reader").catalog.search({ query: ".txt", path: "" })
      ).entries.map((entry) => entry.name),
    ).toEqual(["report.txt"]);
    await caller().shares.create({
      path: "docs",
      expiresAt: null,
      password: "test-password",
    });
    expect(await caller().shares.list()).toMatchObject([
      { passwordProtected: true },
    ]);
    expect(JSON.stringify(await caller().shares.list())).not.toContain(
      "passwordHash",
    );
    await expect(
      caller("reader").shares.create({ path: "docs", expiresAt: null }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
