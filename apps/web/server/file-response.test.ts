import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getAccess } from "@nimbus/api/access";
import { createTestDriveStore } from "@nimbus/api/testing";
import { serveFile, serveZip } from "./file-response";

let root: string;
let previousRoot: string | undefined;
const admin = () => getAccess(createTestDriveStore().store, "user-1");
const get = (headers: Record<string, string> = {}, method = "GET") =>
  new Request("http://localhost/download", { method, headers });

beforeEach(async () => {
  previousRoot = process.env.NIMBUS_DATA_ROOT;
  root = await mkdtemp(path.join(os.tmpdir(), "nimbus-file-response-"));
  process.env.NIMBUS_DATA_ROOT = root;
  await mkdir(path.join(root, "docs/inner"), { recursive: true });
  await writeFile(path.join(root, "docs/a.txt"), "0123456789");
  await writeFile(path.join(root, "docs/inner/b.txt"), "bee");
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  if (previousRoot === undefined) delete process.env.NIMBUS_DATA_ROOT;
  else process.env.NIMBUS_DATA_ROOT = previousRoot;
});

test("serves whole files, single ranges and HEAD with matching lengths", async () => {
  const access = await admin();
  const whole = await serveFile(get(), "docs/a.txt", access);
  expect(whole.status).toBe(200);
  expect(whole.headers.get("content-length")).toBe("10");
  expect(await whole.text()).toBe("0123456789");
  const range = await serveFile(
    get({ range: "bytes=2-4" }),
    "docs/a.txt",
    access,
  );
  expect(range.status).toBe(206);
  expect(range.headers.get("content-range")).toBe("bytes 2-4/10");
  expect(await range.text()).toBe("234");
  const suffix = await serveFile(
    get({ range: "bytes=-3" }),
    "docs/a.txt",
    access,
  );
  expect(await suffix.text()).toBe("789");
  const bad = await serveFile(
    get({ range: "bytes=9-2" }),
    "docs/a.txt",
    access,
  );
  expect(bad.status).toBe(416);
  const head = await serveFile(get({}, "HEAD"), "docs/a.txt", access);
  expect(head.headers.get("content-length")).toBe("10");
  expect(head.body).toBeNull();
});

test("a file replaced after its response starts is served whole, with its own length", async () => {
  const access = await admin();
  const response = await serveFile(get(), "docs/a.txt", access);
  await writeFile(path.join(root, "docs/new.txt"), "short");
  await rename(path.join(root, "docs/new.txt"), path.join(root, "docs/a.txt"));
  expect(response.headers.get("content-length")).toBe("10");
  expect(await response.text()).toBe("0123456789");
  expect(await readFile(path.join(root, "docs/a.txt"), "utf8")).toBe("short");
});

test("symlinks are never served", async () => {
  const access = await admin();
  await symlink(
    path.join(root, "docs/a.txt"),
    path.join(root, "docs/link.txt"),
  );
  await expect(serveFile(get(), "docs/link.txt", access)).rejects.toMatchObject(
    {
      code: "FORBIDDEN",
    },
  );
});

test("folder ZIPs list readable contents relative to the folder", async () => {
  const access = await admin();
  const response = await serveZip("docs", access);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const text = new TextDecoder("latin1").decode(bytes);
  for (const name of ["a.txt", "inner/", "inner/b.txt"])
    expect(text).toContain(name);
  expect(text).not.toContain("docs/");
  // STORE keeps file content verbatim inside the archive.
  expect(text).toContain("0123456789");
  await expect(serveZip("docs/a.txt", access)).rejects.toMatchObject({
    code: "BAD_REQUEST",
  });
});

test("special files are refused without waiting on them", async () => {
  const access = await admin();
  Bun.spawnSync(["mkfifo", path.join(root, "docs/pipe")]);
  await expect(serveFile(get(), "docs/pipe", access)).rejects.toMatchObject({
    code: "BAD_REQUEST",
  });
  await expect(serveFile(get(), "docs/missing", access)).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
});
