import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resetDirListCacheForTest } from "./dir-list-cache";
import { lockFile } from "./file-mutations";
import { resetListCacheForTest } from "./list-cache";
import { McpScope } from "./mcp-scope";
import type { McpToolContext } from "./mcp-tool";
import { mcpTools } from "./mcp-tools";
import { createTestDriveStore } from "./testing";

describe("MCP tools", () => {
  let root: string;
  let previousRoot: string | undefined;
  let memory: ReturnType<typeof createTestDriveStore>;
  let links: string[];

  const context = (userId = "user-1", scopes = McpScope.all): McpToolContext => ({
    userId,
    scopes,
    drive: memory.store,
    preferences: { getUserPreferences: async () => null, setUserPreferences: async (_id, value) => value },
    origin: "https://files.example.test",
    downloadLink: async (requested) => {
      links.push(requested);
      return { url: `https://files.example.test/api/mcp/download/${links.length}`, expiresAt: 0 };
    },
  });
  const call = async (name: string, input: unknown, ctx = context()) => {
    const tool = mcpTools.find((entry) => entry.name === name);
    if (!tool) throw new Error(`No tool named ${name}`);
    return tool.call(ctx, input);
  };
  const value = async (name: string, input: unknown, ctx = context()) => {
    const result = await call(name, input, ctx);
    if (!result.ok) throw new Error(`${name} failed: ${result.message}`);
    return result.value;
  };
  const failure = async (name: string, input: unknown, ctx = context()) => {
    const result = await call(name, input, ctx);
    if (result.ok) throw new Error(`${name} unexpectedly succeeded`);
    return result.message;
  };

  beforeEach(async () => {
    previousRoot = process.env.NIMBUS_DATA_ROOT;
    root = await mkdtemp(path.join(os.tmpdir(), "nimbus-mcp-tools-"));
    process.env.NIMBUS_DATA_ROOT = root;
    memory = createTestDriveStore();
    links = [];
    resetListCacheForTest();
    resetDirListCacheForTest();
    await mkdir(path.join(root, "docs"));
    await mkdir(path.join(root, ".nimbus"));
    await writeFile(path.join(root, "docs", "report.txt"), "quarterly report");
    await writeFile(path.join(root, "private.txt"), "private");
    await symlink(path.join(root, "private.txt"), path.join(root, "docs", "shortcut.txt"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    if (previousRoot === undefined) delete process.env.NIMBUS_DATA_ROOT;
    else process.env.NIMBUS_DATA_ROOT = previousRoot;
  });

  it("declares unique names, a scope, annotations, and object schemas for every tool", () => {
    expect(new Set(mcpTools.map((tool) => tool.name)).size).toBe(mcpTools.length);
    for (const tool of mcpTools) {
      expect(McpScope.isScope(tool.scope)).toBe(true);
      expect(tool.annotations.readOnlyHint).toBe(tool.scope === McpScope.read || tool.name.startsWith("list_"));
    }
  });

  it("lists folders in pages, folders first, without internal storage or symlinks", async () => {
    await mkdir(path.join(root, "archive"));
    const first = await value("list_folder", { path: "", limit: 2 });
    expect(first).toMatchObject({ entries: [{ name: "archive", type: "folder" }, { name: "docs", type: "folder" }], nextCursor: "2" });
    expect(await value("list_folder", { path: "", cursor: "2", limit: 2 })).toMatchObject({ entries: [{ name: "private.txt" }], nextCursor: null });
    const docs = await value("list_folder", { path: "docs" });
    expect(JSON.stringify(docs)).not.toContain("shortcut");
    expect(await failure("read_text", { path: ".nimbus/db.sqlite" })).toContain("private");
    expect(await failure("read_text", { path: "docs/shortcut.txt" })).toContain("Symbolic links");
    expect(await failure("list_folder", { path: "../outside" })).toContain("inside your drive");
  });

  it("refuses tools outside the connection's scopes without acting", async () => {
    const readOnly = context("user-1", [McpScope.read]);
    expect(await failure("move_to_trash", { path: "private.txt" }, readOnly)).toContain('"files:write" scope');
    expect(await failure("create_public_link", { path: "docs" }, readOnly)).toContain('"files:share" scope');
    expect(await readFile(path.join(root, "private.txt"), "utf8")).toBe("private");
    expect(memory.shares.size).toBe(0);
  });

  it("applies the account's own permissions regardless of scopes", async () => {
    const reader = context("reader");
    expect(await failure("list_folder", { path: "docs" }, reader)).toContain("do not have access");
    await value("grant_permission", { path: "docs", subject: { type: "user", email: "READER@example.test" }, permission: "read" });
    expect(await value("read_text", { path: "docs/report.txt" }, reader)).toMatchObject({ content: { kind: "text", text: "quarterly report" } });
    expect(await failure("write_text", { path: "docs/new.txt", content: "x" }, reader)).toContain("write permission");
    expect(await failure("create_public_link", { path: "docs" }, reader)).toContain("admin permission");
    expect(await failure("read_text", { path: "private.txt" }, reader)).toContain("read permission");
  });

  it("stops working immediately when the account is disabled", async () => {
    const reader = memory.users.get("reader");
    if (!reader) throw new Error("Expected the reader account");
    await value("grant_permission", { path: "docs", subject: { type: "user", email: "reader@example.test" }, permission: "read" });
    reader.banned = true;
    expect(await failure("list_folder", { path: "docs" }, context("reader"))).toContain("disabled or removed");
  });

  it("reads text in ranges and reports binary files", async () => {
    expect(await value("read_text", { path: "docs/report.txt", maxBytes: 9 })).toMatchObject({ size: 16, content: { kind: "text", text: "quarterly", nextOffset: 9 } });
    await writeFile(path.join(root, "docs", "photo.jpg"), new Uint8Array([0xff, 0xd8, 0x00]));
    expect(await value("read_text", { path: "docs/photo.jpg" })).toMatchObject({ content: { kind: "binary" } });
  });

  it("creates files but replaces them only when asked, checking the etag", async () => {
    expect(await value("write_text", { path: "docs/notes.md", content: "# Notes" })).toMatchObject({ outcome: "created", entry: { path: "docs/notes.md" } });
    expect(await failure("write_text", { path: "docs/notes.md", content: "changed" })).toContain("already exists");
    const { etag } = await value("get_item", { path: "docs/notes.md" });
    expect(await failure("write_text", { path: "docs/notes.md", content: "changed", expectedEtag: '"0-0"' })).toContain("changed since you read it");
    expect(await value("write_text", { path: "docs/notes.md", content: "changed", expectedEtag: etag })).toMatchObject({ outcome: "replaced" });
    expect(await readFile(path.join(root, "docs", "notes.md"), "utf8")).toBe("changed");
    expect(await failure("write_text", { path: "missing/notes.md", content: "x" })).toContain("create_folder");
  });

  it("respects WebDAV locks", async () => {
    lockFile("docs/report.txt", { userId: "user-1" });
    expect(await failure("rename_item", { path: "docs/report.txt", newName: "final.txt" })).toContain("locked by a WebDAV client");
    expect(await failure("write_text", { path: "docs/report.txt", content: "x", overwrite: true })).toContain("locked");
  });

  it("moves items to trash and restores them by id", async () => {
    const trashed = await value("move_to_trash", { path: "docs/report.txt" });
    expect(trashed.trashId).toEqual(expect.any(String));
    expect(await value("list_trash", {})).toMatchObject({ items: [{ id: trashed.trashId, path: "docs/report.txt" }] });
    expect(await value("restore_from_trash", { trashId: trashed.trashId })).toEqual({ path: "docs/report.txt" });
    expect(await readFile(path.join(root, "docs", "report.txt"), "utf8")).toBe("quarterly report");
  });

  it("creates, lists, and revokes public links with absolute URLs", async () => {
    const link = await value("create_public_link", { path: "docs" });
    expect(String(link.url)).toStartWith("https://files.example.test/s/");
    expect(await value("list_public_links", {})).toMatchObject({ links: [{ id: link.id, path: "docs" }] });
    expect(await value("revoke_public_link", { linkId: link.id })).toEqual({ revoked: true });
    expect(await failure("revoke_public_link", { linkId: link.id })).toContain("None of your public links");
  });

  it("lists and revokes grants by name for administrators of the path", async () => {
    await value("grant_permission", { path: "docs", subject: { type: "user", email: "reader@example.test" }, permission: "write" });
    const listed = await value("list_permissions", { path: "docs" });
    expect(listed).toMatchObject({ grants: [{ subject: { type: "user", name: "Reader", email: "reader@example.test" }, permission: "write" }] });
    const grants = listed.grants;
    if (!Array.isArray(grants)) throw new Error("Expected grants");
    const [grant] = grants;
    await value("revoke_permission", { path: "docs", grantId: grant.grantId });
    expect(await value("list_permissions", { path: "docs" })).toMatchObject({ grants: [] });
    expect(await failure("grant_permission", { path: "docs", subject: { type: "user", email: "nobody@example.test" }, permission: "read" })).toContain("No active Nimbus user");
  });

  it("issues download links only for items the account can read", async () => {
    expect(await value("get_download_link", { path: "docs" })).toMatchObject({ type: "folder" });
    expect(await failure("get_download_link", { path: "private.txt" }, context("reader"))).toContain("read permission");
    expect(links).toEqual(["docs"]);
  });

  it("explains invalid arguments", async () => {
    expect(await failure("read_text", { path: "docs/report.txt", maxBytes: 0 })).toContain("input schema");
  });
});
