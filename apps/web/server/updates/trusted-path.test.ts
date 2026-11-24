import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TrustedPath } from "./trusted-path";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "nimbus-trusted-"));
});
afterEach(async () => {
  await chmod(root, 0o755).catch(() => undefined);
  await rm(root, { recursive: true, force: true });
});

test("a folder is trusted when nobody else can write it or replace a folder on its way", async () => {
  const folder = path.join(root, "a/b");
  await mkdir(folder, { recursive: true, mode: 0o755 });
  await chmod(root, 0o755);
  expect((await TrustedPath.folder(folder)).ok).toBe(true);
  // Writable by others on the way: someone could rename it away and put another in its place.
  await chmod(path.join(root, "a"), 0o777);
  const open = await TrustedPath.folder(folder);
  expect(open.ok || open.message).toContain("writable by others");
  // Sticky, as /tmp: others can add entries but not rename or remove this one.
  await chmod(path.join(root, "a"), 0o1777);
  expect((await TrustedPath.folder(folder)).ok).toBe(true);
  // The folder itself may never be writable by others, sticky or not.
  await chmod(folder, 0o1777);
  expect((await TrustedPath.folder(folder)).ok).toBe(false);
});
