import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getAccess } from "./access";
import type { FileEntry } from "./file-browser";
import { commitStagedFile, readFileText, stageFile } from "./file-content";
import { lockFile } from "./file-mutations";
import { FileVersions } from "./file-versions";
import { createTestDriveStore } from "./testing";

describe("file content", () => {
  let root: string;
  let previousRoot: string | undefined;
  let memory: ReturnType<typeof createTestDriveStore>;
  const access = (id = "user-1") => getAccess(memory.store, id);
  const write = async (
    requested: string,
    body: string,
    accepts: (current: FileEntry | null) => boolean = () => true,
    id = "user-1",
  ) => {
    const staged = await stageFile(body);
    try {
      return await commitStagedFile(
        {
          userId: id,
          authorize: () => access(id),
          drive: memory.store,
        },
        requested,
        staged,
        accepts,
      );
    } finally {
      await staged.discard();
    }
  };

  beforeEach(async () => {
    previousRoot = process.env.NIMBUS_DATA_ROOT;
    root = await mkdtemp(path.join(os.tmpdir(), "nimbus-content-"));
    process.env.NIMBUS_DATA_ROOT = root;
    memory = createTestDriveStore();
    await mkdir(path.join(root, "docs"));
    await writeFile(path.join(root, "docs", "notes.txt"), "héllo world");
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    if (previousRoot === undefined) delete process.env.NIMBUS_DATA_ROOT;
    else process.env.NIMBUS_DATA_ROOT = previousRoot;
  });

  it("reads a bounded byte range and reports where the next range starts", async () => {
    const first = await readFileText(await access(), "docs/notes.txt", {
      offset: 0,
      maxBytes: 4,
    });
    // "h" + "é" (2 bytes) + "l" fit in 4 bytes; nothing is split mid-character.
    expect(first).toMatchObject({
      kind: "text",
      content: "hél",
      offset: 0,
      nextOffset: 4,
      size: 12,
    });
    const rest = await readFileText(await access(), "docs/notes.txt", {
      offset: 4,
      maxBytes: 100,
    });
    expect(rest).toMatchObject({
      kind: "text",
      content: "lo world",
      nextOffset: null,
    });
  });

  it("never splits a multi-byte character at the end of a range", async () => {
    const read = await readFileText(await access(), "docs/notes.txt", {
      offset: 0,
      maxBytes: 2,
    });
    expect(read).toMatchObject({ kind: "text", content: "h", nextOffset: 1 });
  });

  it("rejects an offset inside a multi-byte character", async () => {
    await expect(
      readFileText(await access(), "docs/notes.txt", {
        offset: 2,
        maxBytes: 10,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("reports binary content instead of decoding it", async () => {
    await writeFile(
      path.join(root, "docs", "image.bin"),
      new Uint8Array([0x89, 0x50, 0x00, 0x47]),
    );
    expect(
      await readFileText(await access(), "docs/image.bin", {
        offset: 0,
        maxBytes: 100,
      }),
    ).toMatchObject({ kind: "binary", size: 4 });
  });

  it("requires read permission and refuses folders, internal storage, and symlinks", async () => {
    await expect(
      readFileText(await access("reader"), "docs/notes.txt", {
        offset: 0,
        maxBytes: 10,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      readFileText(await access(), "docs", { offset: 0, maxBytes: 10 }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await mkdir(path.join(root, ".nimbus"));
    await writeFile(path.join(root, ".nimbus", "db.sqlite"), "secret");
    await expect(
      readFileText(await access(), ".nimbus/db.sqlite", {
        offset: 0,
        maxBytes: 10,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await symlink(
      path.join(root, "docs", "notes.txt"),
      path.join(root, "link.txt"),
    );
    await expect(
      readFileText(await access(), "link.txt", { offset: 0, maxBytes: 10 }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("creates and replaces files, reporting the resulting entry", async () => {
    expect(await write("docs/new.txt", "fresh")).toMatchObject({
      kind: "created",
      entry: { path: "docs/new.txt", size: 5 },
    });
    expect(await write("docs/new.txt", "updated")).toMatchObject({
      kind: "replaced",
      entry: { size: 7 },
    });
    expect(await readFile(path.join(root, "docs", "new.txt"), "utf8")).toBe(
      "updated",
    );
  });

  it("keeps the replaced content as a version", async () => {
    await write("docs/notes.txt", "rewritten");
    const [version] = await FileVersions.history(
      memory.store.versions,
      "docs/notes.txt",
    );
    expect(version).toMatchObject({
      name: "notes.txt",
      size: Buffer.byteLength("héllo world"),
      archivedBy: "user-1",
    });
  });

  it("leaves the file unchanged when the caller's precondition rejects its current state", async () => {
    const outcome = await write(
      "docs/notes.txt",
      "overwritten",
      (current) => current === null,
    );
    expect(outcome).toMatchObject({
      kind: "precondition_failed",
      current: { path: "docs/notes.txt" },
    });
    expect(await readFile(path.join(root, "docs", "notes.txt"), "utf8")).toBe(
      "héllo world",
    );
  });

  it("reports folders and missing parents as outcomes without writing", async () => {
    expect(await write("docs", "x")).toEqual({ kind: "is_directory" });
    expect(await write("missing/file.txt", "x")).toEqual({
      kind: "missing_parent",
    });
  });

  it("requires write permission and respects WebDAV locks", async () => {
    await expect(
      write("docs/new.txt", "x", () => true, "reader"),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    lockFile("docs/notes.txt", { userId: "user-1" });
    await expect(write("docs/notes.txt", "x")).rejects.toMatchObject({
      name: "FileLockedError",
    });
  });

  it("removes staged content after a write or a refusal", async () => {
    await write("docs/new.txt", "fresh");
    await write("docs/notes.txt", "refused", () => false);
    expect(await readdir(path.join(root, ".nimbus", "uploads"))).toEqual([]);
  });
});
