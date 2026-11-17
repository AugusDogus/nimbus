import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getAccess } from "@nimbus/api/access";
import {
  lockFile,
  forgetFileMutationsForTest,
} from "@nimbus/api/file-mutations";
import { FileVersions } from "@nimbus/api/file-versions";
import { createTestDriveStore } from "@nimbus/api/testing";
import { fileETag, saveFileContent } from "./file-content";

let root: string;
let previousRoot: string | undefined;
let memory: ReturnType<typeof createTestDriveStore>;
const body = (text: string) => new Blob([text]).stream();

beforeEach(async () => {
  previousRoot = process.env.NIMBUS_DATA_ROOT;
  root = await mkdtemp(path.join(os.tmpdir(), "nimbus-content-"));
  process.env.NIMBUS_DATA_ROOT = root;
  memory = createTestDriveStore();
  await mkdir(path.join(root, "docs"));
  await writeFile(path.join(root, "docs/notes.txt"), "first");
});
afterEach(async () => {
  forgetFileMutationsForTest(root);
  // Assigning undefined would store the string "undefined", a data root in the working directory.
  if (previousRoot === undefined) delete process.env.NIMBUS_DATA_ROOT;
  else process.env.NIMBUS_DATA_ROOT = previousRoot;
  await rm(root, { recursive: true, force: true });
});

const currentTag = async () =>
  fileETag(await stat(path.join(root, "docs/notes.txt")));

test("saves when the precondition matches and returns the new tag", async () => {
  const access = await getAccess(memory.store, "user-1");
  const result = await saveFileContent({
    store: memory.store,
    access,
    requested: "docs/notes.txt",
    ifMatch: await currentTag(),
    body: body("second"),
  });
  expect(await readFile(path.join(root, "docs/notes.txt"), "utf8")).toBe(
    "second",
  );
  expect(result.etag).toBe(await currentTag());
  expect(await readdir(path.join(root, ".nimbus/uploads"))).toEqual([]);
});

test("keeps the previous content as a version", async () => {
  const access = await getAccess(memory.store, "user-1");
  await saveFileContent({
    store: memory.store,
    access,
    requested: "docs/notes.txt",
    ifMatch: await currentTag(),
    body: body("second"),
  });
  const [version] = await FileVersions.history(
    memory.store.versions,
    "docs/notes.txt",
  );
  expect(version).toMatchObject({
    name: "notes.txt",
    size: "first".length,
    archivedBy: "user-1",
  });
});

test("rejects a stale precondition without changing the file", async () => {
  const access = await getAccess(memory.store, "user-1");
  const stale = await currentTag();
  await writeFile(path.join(root, "docs/notes.txt"), "changed elsewhere");
  await expect(
    saveFileContent({
      store: memory.store,
      access,
      requested: "docs/notes.txt",
      ifMatch: stale,
      body: body("mine"),
    }),
  ).rejects.toMatchObject({ name: "PreconditionFailedError" });
  expect(await readFile(path.join(root, "docs/notes.txt"), "utf8")).toBe(
    "changed elsewhere",
  );
  expect(await readdir(path.join(root, ".nimbus/uploads"))).toEqual([]);
});

test("requires write permission", async () => {
  memory.grants.set("g", {
    id: "g",
    path: "docs",
    permission: "read",
    subject: { type: "user", id: "reader" },
  });
  const access = await getAccess(memory.store, "reader");
  await expect(
    saveFileContent({
      store: memory.store,
      access,
      requested: "docs/notes.txt",
      ifMatch: await currentTag(),
      body: body("x"),
    }),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  expect(await readFile(path.join(root, "docs/notes.txt"), "utf8")).toBe(
    "first",
  );
});

test("respects WebDAV locks held by another client", async () => {
  lockFile("docs/notes.txt", { userId: "user-1" });
  const access = await getAccess(memory.store, "user-1");
  await expect(
    saveFileContent({
      store: memory.store,
      access,
      requested: "docs/notes.txt",
      ifMatch: await currentTag(),
      body: body("x"),
    }),
  ).rejects.toMatchObject({ name: "FileLockedError" });
  expect(await readFile(path.join(root, "docs/notes.txt"), "utf8")).toBe(
    "first",
  );
});

test("refuses folders, missing files and oversized bodies", async () => {
  const access = await getAccess(memory.store, "user-1");
  await expect(
    saveFileContent({
      store: memory.store,
      access,
      requested: "docs",
      ifMatch: "*",
      body: body("x"),
    }),
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  await expect(
    saveFileContent({
      store: memory.store,
      access,
      requested: "docs/missing.txt",
      ifMatch: "*",
      body: body("x"),
    }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(
    saveFileContent({
      store: memory.store,
      access,
      requested: "docs/notes.txt",
      ifMatch: await currentTag(),
      body: body("x".repeat(64)),
      maxBytes: 16,
    }),
  ).rejects.toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
  expect(await readFile(path.join(root, "docs/notes.txt"), "utf8")).toBe(
    "first",
  );
});
