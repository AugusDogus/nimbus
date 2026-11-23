import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  chmod,
  mkdir,
  readdir,
  readFile,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { FilesystemCapacity } from "@nimbus/api/filesystem-capacity";
import type { UploadDestination } from "@nimbus/api/upload-destination";
import { user } from "../db/auth-schema";
import { mcpClients, mcpGrants } from "../db/mcp-schema";
import { openTestDrive, type TestDrive } from "../drive-testing";
import {
  MAX_RUNNING_PER_LINK,
  McpUpload,
  type McpUploadContext,
} from "./upload";
import { UPLOAD_LINK_TTL_MS, UploadLink } from "./upload-link";

const secret = "s".repeat(32);
const origin = "https://files.example.test";
const gib = 1024 ** 3;

const answer = z.object({
  outcome: z.enum(["created", "replaced"]),
  path: z.string(),
  size: z.number(),
  etag: z.string(),
});
const refusal = z.object({ error: z.string() });

/** A body that yields `chunks`, then runs `end` and either finishes or fails. */
function streamOf(chunks: string[], end: () => Promise<void> = async () => {}) {
  const queue = [...chunks];
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = queue.shift();
      if (next !== undefined) {
        controller.enqueue(new TextEncoder().encode(next));
        return;
      }
      await end();
      controller.close();
    },
  });
}

describe("MCP upload links", () => {
  let drive: TestDrive;
  let now: number;
  let capacity: FilesystemCapacity | null;
  let grants = 0;
  let startedAt: number;

  const context = (): McpUploadContext => ({
    db: drive.db,
    drive: drive.store,
    secret,
    startedAt,
    origins: new Set([origin]),
    now: () => now,
    capacity: async () => capacity,
  });

  async function connect(
    userId: string,
    scope = "files:read files:write",
  ): Promise<string> {
    const grantId = `grant-${userId}-${++grants}`;
    await drive.db.insert(mcpClients).values({
      clientId: `client-${grantId}`,
      clientName: "Agent",
      redirectUrisJson: "[]",
      tokenEndpointAuthMethod: "none",
      scope,
      createdAt: now,
    });
    await drive.db.insert(mcpGrants).values({
      id: grantId,
      userId,
      clientId: `client-${grantId}`,
      scope,
      createdAt: now,
    });
    return grantId;
  }

  async function link(destination: UploadDestination, userId = "owner") {
    const grantId = await connect(userId);
    return {
      grantId,
      token: UploadLink.sign(secret, { userId, grantId, destination }, now)
        .token,
    };
  }

  const put = (
    token: string,
    body: BodyInit | null,
    { rest = "", headers = {} }: { rest?: string; headers?: HeadersInit } = {},
  ) =>
    McpUpload.handle(
      context(),
      new Request(`${origin}/api/mcp/upload/${token}`, {
        method: "PUT",
        body,
        headers,
      }),
      { token, rest },
    );

  async function staged() {
    try {
      return await readdir(drive.absolute(".nimbus/uploads"));
    } catch {
      return [];
    }
  }

  beforeEach(async () => {
    drive = await openTestDrive();
    now = 1_000_000;
    startedAt = 0;
    capacity = null;
    await mkdir(drive.absolute("docs"));
    await drive.write("docs/report.txt", "quarterly report");
  });
  afterEach(async () => {
    await drive.close();
  });

  it("streams a new file into the drive and answers with its path, size and etag", async () => {
    const { token } = await link({
      kind: "file",
      path: "docs/video.mp4",
      rule: { kind: "refuse" },
    });
    const response = await put(token, streamOf(["\u0000binary", "ÿ"]));
    expect(response.status).toBe(201);
    const body = answer.parse(await response.json());
    const written = await readFile(drive.absolute("docs/video.mp4"));
    expect(written.toString("latin1")).toBe(
      Buffer.from("\u0000binaryÿ").toString("latin1"),
    );
    const stats = await stat(drive.absolute("docs/video.mp4"));
    expect(body).toEqual({
      outcome: "created",
      path: "docs/video.mp4",
      size: written.length,
      etag: `"${stats.mtimeMs}-${stats.size}"`,
    });
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(await staged()).toEqual([]);
  });

  it("uploads to the drive root through a file link and a folder link", async () => {
    const file = await link({
      kind: "file",
      path: "at-root.txt",
      rule: { kind: "refuse" },
    });
    expect((await put(file.token, "file link")).status).toBe(201);
    const folder = await link({
      kind: "folder",
      path: "",
      rule: { kind: "refuse" },
    });
    expect(
      (await put(folder.token, "folder link", { rest: "new/in-root.txt" }))
        .status,
    ).toBe(201);
    expect(await readFile(drive.absolute("at-root.txt"), "utf8")).toBe(
      "file link",
    );
    expect(await readFile(drive.absolute("new/in-root.txt"), "utf8")).toBe(
      "folder link",
    );
  });

  it("uses each link once for each path", async () => {
    const { token } = await link({
      kind: "file",
      path: "docs/once.txt",
      rule: { kind: "overwrite" },
    });
    expect((await put(token, "first")).status).toBe(201);
    const again = await put(token, "second");
    expect(again.status).toBe(410);
    expect(refusal.parse(await again.json()).error).toContain(
      "already uploaded",
    );
    expect(await readFile(drive.absolute("docs/once.txt"), "utf8")).toBe(
      "first",
    );
  });

  it("records each committed path in the database, where the next server refuses it", async () => {
    const { token } = await link({
      kind: "file",
      path: "docs/once.txt",
      rule: { kind: "overwrite" },
    });
    expect((await put(token, "first")).status).toBe(201);
    // All a server after an update shares with this one is the database.
    const claims = drive.sqlite
      .query<{ expires_at: number }, []>(
        "SELECT expires_at FROM nimbus_mcp_upload_claim",
      )
      .all();
    expect(claims).toEqual([{ expires_at: now + UPLOAD_LINK_TTL_MS }]);
    const again = await put(token, "second");
    expect(again.status).toBe(410);
    // A refused or failed upload commits nothing and keeps no claim of its own.
    const refusedLink = await link({
      kind: "file",
      path: "docs/report.txt",
      rule: { kind: "refuse" },
    });
    expect((await put(refusedLink.token, "replacement")).status).toBe(409);
    expect(
      drive.sqlite.query("SELECT key FROM nimbus_mcp_upload_claim").all(),
    ).toHaveLength(1);
  });

  it("refuses to start once expired, but lets a started upload finish", async () => {
    const { token } = await link({
      kind: "file",
      path: "docs/late.txt",
      rule: { kind: "refuse" },
    });
    const started = await put(
      token,
      streamOf(["slow "], async () => {
        now += UPLOAD_LINK_TTL_MS * 2;
      }),
    );
    expect(started.status).toBe(201);
    const { token: other } = await link({
      kind: "file",
      path: "docs/later.txt",
      rule: { kind: "refuse" },
    });
    now += UPLOAD_LINK_TTL_MS;
    const expired = await put(other, "x");
    expect(expired.status).toBe(410);
    expect(refusal.parse(await expired.json()).error).toContain("expired");
  });

  it("refuses forged links, other paths and traversal", async () => {
    expect((await put("garbage", "x")).status).toBe(404);
    const file = await link({
      kind: "file",
      path: "docs/a.txt",
      rule: { kind: "refuse" },
    });
    expect((await put(file.token, "x", { rest: "b.txt" })).status).toBe(404);
    const folder = await link({
      kind: "folder",
      path: "docs",
      rule: { kind: "refuse" },
    });
    for (const rest of [
      "",
      "../escape.txt",
      "sub/../../escape.txt",
      "./x.txt",
      ".nimbus/x",
      "sub/.NIMBUS/x",
      " lead.txt",
      "a//b.txt",
      "tab\there.txt",
      "back\\slash.txt",
    ]) {
      const response = await put(folder.token, "x", { rest });
      expect(response.status).toBe(400);
    }
    expect(await readdir(drive.absolute("docs"))).toEqual(["report.txt"]);
    expect(await readdir(drive.root)).not.toContain("escape.txt");
  });

  it("refuses links whose connection lost files:write, was disconnected or whose account is disabled", async () => {
    const destination: UploadDestination = {
      kind: "file",
      path: "docs/new.txt",
      rule: { kind: "refuse" },
    };
    const readOnly = await connect("owner", "files:read");
    const narrowed = UploadLink.sign(
      secret,
      { userId: "owner", grantId: readOnly, destination },
      now,
    ).token;
    expect((await put(narrowed, "x")).status).toBe(403);

    const revoked = await link(destination);
    await drive.db
      .update(mcpGrants)
      .set({ revokedAt: now })
      .where(eq(mcpGrants.id, revoked.grantId));
    const refused = await put(revoked.token, "x");
    expect(refused.status).toBe(403);
    expect(refusal.parse(await refused.json()).error).toContain("disconnected");

    const disabled = await link(destination, "alice");
    await drive.grant("docs", "alice", "write");
    await drive.db
      .update(user)
      .set({ banned: true })
      .where(eq(user.id, "alice"));
    expect((await put(disabled.token, "x")).status).toBe(403);

    const otherUser = await link(destination, "alice");
    const borrowed = UploadLink.sign(
      secret,
      { userId: "bob", grantId: otherUser.grantId, destination },
      now,
    ).token;
    expect((await put(borrowed, "x")).status).toBe(403);
    await expect(stat(drive.absolute("docs/new.txt"))).rejects.toThrow();
  });

  it("re-checks write access at commit and keeps nothing when it was revoked", async () => {
    const grant = await drive.grant("docs", "alice", "write");
    const { token } = await link(
      { kind: "file", path: "docs/alice.txt", rule: { kind: "refuse" } },
      "alice",
    );
    const response = await put(
      token,
      streamOf(["half"], async () => {
        await drive.store.removeGrant(grant.id);
      }),
    );
    expect(response.status).toBe(403);
    expect(refusal.parse(await response.json()).error).toContain(
      "write permission",
    );
    await expect(stat(drive.absolute("docs/alice.txt"))).rejects.toThrow();
    expect(await staged()).toEqual([]);
  });

  it("refuses to start for an account without write access, before reading what is there", async () => {
    const { token } = await link(
      { kind: "file", path: "docs/report.txt", rule: { kind: "overwrite" } },
      "bob",
    );
    const response = await put(token, "x");
    expect(response.status).toBe(403);
    expect(await readFile(drive.absolute("docs/report.txt"), "utf8")).toBe(
      "quarterly report",
    );
  });

  it("applies write_text's conflict rules and keeps the replaced version", async () => {
    const refused = await link({
      kind: "file",
      path: "docs/report.txt",
      rule: { kind: "refuse" },
    });
    const conflict = await put(refused.token, "new");
    expect(conflict.status).toBe(409);
    expect(refusal.parse(await conflict.json()).error).toContain(
      "already exists",
    );

    const stale = await link({
      kind: "file",
      path: "docs/report.txt",
      rule: { kind: "match", etag: '"1-1"' },
    });
    expect((await put(stale.token, "new")).status).toBe(412);

    const before = await stat(drive.absolute("docs/report.txt"));
    const matching = await link({
      kind: "file",
      path: "docs/report.txt",
      rule: { kind: "match", etag: `"${before.mtimeMs}-${before.size}"` },
    });
    const replaced = await put(matching.token, "revised report");
    expect(replaced.status).toBe(200);
    expect(answer.parse(await replaced.json()).outcome).toBe("replaced");
    const versions = await drive.store.versions.list("docs/report.txt");
    expect(versions.map((version) => version.size)).toEqual([
      "quarterly report".length,
    ]);
    expect(versions[0]?.archivedBy).toBe("owner");

    const overwrite = await link({
      kind: "file",
      path: "docs/report.txt",
      rule: { kind: "overwrite" },
    });
    expect((await put(overwrite.token, "third")).status).toBe(200);
    expect(await drive.store.versions.list("docs/report.txt")).toHaveLength(2);

    const both = await link({
      kind: "file",
      path: "docs/report.txt",
      rule: { kind: "keep-both" },
    });
    const kept = await put(both.token, "fourth");
    expect(answer.parse(await kept.json()).path).toBe("docs/report (1).txt");
    expect(await readFile(drive.absolute("docs/report.txt"), "utf8")).toBe(
      "third",
    );
  });

  it("detects a conflict that appears while the bytes arrive", async () => {
    const { token } = await link({
      kind: "file",
      path: "docs/race.txt",
      rule: { kind: "refuse" },
    });
    const response = await put(
      token,
      streamOf(["mine"], async () => {
        await writeFile(drive.absolute("docs/race.txt"), "theirs");
      }),
    );
    expect(response.status).toBe(409);
    expect(await readFile(drive.absolute("docs/race.txt"), "utf8")).toBe(
      "theirs",
    );
    expect(await staged()).toEqual([]);
    // Nothing was committed, so the link may still upload once the conflict is resolved.
  });

  it("uploads many files below a folder link, creating subfolders", async () => {
    const { token } = await link({
      kind: "folder",
      path: "docs",
      rule: { kind: "refuse" },
    });
    for (const rest of ["a.txt", "photos/2026/b c.jpg", "photos/é.txt"]) {
      const response = await put(token, `content of ${rest}`, { rest });
      expect(response.status).toBe(201);
      expect(answer.parse(await response.json()).path).toBe(`docs/${rest}`);
      expect(await readFile(drive.absolute(`docs/${rest}`), "utf8")).toBe(
        `content of ${rest}`,
      );
    }
    expect((await put(token, "again", { rest: "a.txt" })).status).toBe(410);
    expect(await staged()).toEqual([]);
  });

  it("never writes through a symbolic link or into a folder the server cannot write", async () => {
    await mkdir(
      path.join(drive.root, "..", path.basename(drive.root) + "-outside"),
      {
        recursive: true,
      },
    );
    const outside = `${drive.root}-outside`;
    await symlink(outside, drive.absolute("docs/linked"));
    const folder = await link({
      kind: "folder",
      path: "docs",
      rule: { kind: "overwrite" },
    });
    const through = await put(folder.token, "x", { rest: "linked/x.txt" });
    expect(through.status).toBe(403);
    expect(await readdir(outside)).toEqual([]);

    await mkdir(drive.absolute("locked"));
    await chmod(drive.absolute("locked"), 0o500);
    try {
      const locked = await link({
        kind: "file",
        path: "locked/x.txt",
        rule: { kind: "refuse" },
      });
      const response = await put(locked.token, "x");
      expect(response.status).toBe(403);
      const message = refusal.parse(await response.json()).error;
      expect(message).toContain("Nimbus service account");
      expect(message).not.toContain(drive.root);
      await chmod(drive.absolute("locked"), 0o000);
      const unreadable = await link({
        kind: "file",
        path: "locked/y.txt",
        rule: { kind: "refuse" },
      });
      const hidden = await put(unreadable.token, "x");
      expect(hidden.status).toBe(403);
      expect(await hidden.text()).not.toContain(drive.root);
    } finally {
      await chmod(drive.absolute("locked"), 0o700);
    }
    expect(await staged()).toEqual([]);
    const { rm } = await import("node:fs/promises");
    await rm(outside, { recursive: true, force: true });
  });

  it("keeps nothing when the client goes away mid-upload", async () => {
    const { token } = await link({
      kind: "file",
      path: "docs/broken.bin",
      rule: { kind: "refuse" },
    });
    const response = await put(
      token,
      streamOf(["part"], async () => {
        throw new Error("connection reset");
      }),
    );
    expect(response.status).toBe(400);
    expect(refusal.parse(await response.json()).error).toContain(
      "stopped before all of its bytes arrived",
    );
    await expect(stat(drive.absolute("docs/broken.bin"))).rejects.toThrow();
    expect(await staged()).toEqual([]);
  });

  it("keeps the free-space floor of the filesystem the file lands on", async () => {
    await mkdir(drive.absolute("docs/mounted"));
    // Only the folder below the link's folder is short of space, as a disk mounted there would be.
    const short = drive.absolute("docs/mounted");
    const context = (): McpUploadContext => ({
      db: drive.db,
      drive: drive.store,
      secret,
      startedAt,
      origins: new Set([origin]),
      now: () => now,
      capacity: async (directory) =>
        directory === short
          ? { totalBytes: 10 * gib, availableBytes: gib + 2 }
          : null,
    });
    const { token } = await link({
      kind: "folder",
      path: "docs",
      rule: { kind: "refuse" },
    });
    const response = await McpUpload.handle(
      context(),
      new Request(`${origin}/api/mcp/upload/${token}/mounted/x.bin`, {
        method: "PUT",
        body: "123",
      }),
      { token, rest: "mounted/x.bin" },
    );
    expect(response.status).toBe(507);
    await expect(stat(drive.absolute("docs/mounted/x.bin"))).rejects.toThrow();
  });

  it("counts every running upload against the free-space floor", async () => {
    capacity = { totalBytes: 10 * gib, availableBytes: gib + 4 };
    const first = await link({
      kind: "file",
      path: "docs/first.bin",
      rule: { kind: "refuse" },
    });
    const second = await link({
      kind: "file",
      path: "docs/second.bin",
      rule: { kind: "refuse" },
    });
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    let received: () => void = () => {};
    const streaming = new Promise<void>((resolve) => (received = resolve));
    const running = put(
      first.token,
      streamOf(["abc"], async () => {
        received();
        await held;
      }),
    );
    await streaming;
    expect((await put(second.token, streamOf(["abc"]))).status).toBe(507);
    release();
    expect((await running).status).toBe(201);
    await expect(stat(drive.absolute("docs/second.bin"))).rejects.toThrow();
  });

  it("keeps its single use when saving fails after the file was replaced", async () => {
    const versions = drive.store.versions;
    let failing = true;
    const store = {
      ...drive.store,
      versions: {
        ...versions,
        list: async (relative: string) => {
          if (failing) throw new Error("retention failed");
          return versions.list(relative);
        },
      },
    };
    const { token } = await link({
      kind: "file",
      path: "docs/report.txt",
      rule: { kind: "overwrite" },
    });
    const request = (body: string) =>
      McpUpload.handle(
        { ...context(), drive: store },
        new Request(`${origin}/api/mcp/upload/${token}`, {
          method: "PUT",
          body,
        }),
        { token, rest: "" },
      );
    expect((await request("first")).status).toBe(500);
    failing = false;
    expect((await request("second")).status).toBe(410);
    expect(await readFile(drive.absolute("docs/report.txt"), "utf8")).toBe(
      "first",
    );
  });

  it("treats spellings of one path as the same path", async () => {
    const { token } = await link({
      kind: "folder",
      path: "docs",
      rule: { kind: "overwrite" },
    });
    expect((await put(token, "one", { rest: "Notes.txt" })).status).toBe(201);
    expect((await put(token, "two", { rest: "NOTES.txt" })).status).toBe(410);
  });

  it("refuses a raw ? or # rather than cutting the name short", async () => {
    const { token } = await link({
      kind: "folder",
      path: "docs",
      rule: { kind: "overwrite" },
    });
    const response = await McpUpload.handle(
      context(),
      new Request(`${origin}/api/mcp/upload/${token}/report.txt?backup`, {
        method: "PUT",
        body: "x",
      }),
      { token, rest: "report.txt" },
    );
    expect(response.status).toBe(400);
    expect(refusal.parse(await response.json()).error).toContain("%3F");
    expect(await readFile(drive.absolute("docs/report.txt"), "utf8")).toBe(
      "quarterly report",
    );
  });

  it("limits how many uploads one link runs at once", async () => {
    const { token } = await link({
      kind: "folder",
      path: "docs",
      rule: { kind: "refuse" },
    });
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const started: Promise<void>[] = [];
    const running: Promise<Response>[] = [];
    for (let index = 0; index < MAX_RUNNING_PER_LINK; index++) {
      let begin: () => void = () => {};
      started.push(new Promise<void>((resolve) => (begin = resolve)));
      running.push(
        put(
          token,
          streamOf(["x"], async () => {
            begin();
            await held;
          }),
          { rest: `parallel-${index}.txt` },
        ),
      );
    }
    await Promise.all(started);
    const extra = await put(token, "x", { rest: "one-too-many.txt" });
    expect(extra.status).toBe(429);
    release();
    for (const response of await Promise.all(running))
      expect(response.status).toBe(201);
  });

  it("keeps the free-space floor, before and during an upload", async () => {
    // 2 GiB free on a 10 GiB disk: 1 GiB may be written.
    capacity = { totalBytes: 10 * gib, availableBytes: 2 * gib };
    const declared = await link({
      kind: "file",
      path: "docs/big.bin",
      rule: { kind: "refuse" },
    });
    const refused = await put(declared.token, "x", {
      headers: { "content-length": String(gib + 1) },
    });
    expect(refused.status).toBe(507);
    expect(refusal.parse(await refused.json()).error).toContain(
      "Nothing was saved",
    );

    capacity = { totalBytes: 10 * gib, availableBytes: gib + 4 };
    const streamed = await link({
      kind: "file",
      path: "docs/stream.bin",
      rule: { kind: "refuse" },
    });
    const response = await put(streamed.token, streamOf(["1234", "5"]));
    expect(response.status).toBe(507);
    await expect(stat(drive.absolute("docs/stream.bin"))).rejects.toThrow();
    expect(await staged()).toEqual([]);

    capacity = { totalBytes: 10 * gib, availableBytes: gib };
    const full = await link({
      kind: "file",
      path: "docs/none.bin",
      rule: { kind: "refuse" },
    });
    expect((await put(full.token, streamOf(["x"]))).status).toBe(507);
  });

  it("refuses requests from web pages on other sites", async () => {
    const { token } = await link({
      kind: "file",
      path: "docs/cross.txt",
      rule: { kind: "refuse" },
    });
    const response = await put(token, "x", {
      headers: { origin: "https://evil.example" },
    });
    expect(response.status).toBe(403);
    await expect(stat(drive.absolute("docs/cross.txt"))).rejects.toThrow();
  });

  it("runs one upload of a path per link at a time", async () => {
    const { token } = await link({
      kind: "file",
      path: "docs/one.txt",
      rule: { kind: "refuse" },
    });
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    let started: () => void = () => {};
    const streaming = new Promise<void>((resolve) => (started = resolve));
    const first = put(
      token,
      streamOf(["a"], async () => {
        started();
        await held;
      }),
    );
    await streaming;
    const second = await put(token, "b");
    expect(second.status).toBe(409);
    release();
    expect((await first).status).toBe(201);
  });

  it("refuses links made before the server last started", async () => {
    const { token } = await link({
      kind: "file",
      path: "docs/restart.txt",
      rule: { kind: "overwrite" },
    });
    expect((await put(token, "first")).status).toBe(201);
    startedAt = now + 1;
    now += 2;
    const again = await put(token, "second");
    expect(again.status).toBe(410);
    expect(refusal.parse(await again.json()).error).toContain("restarted");
    expect(await readFile(drive.absolute("docs/restart.txt"), "utf8")).toBe(
      "first",
    );
  });
});
