import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ReleaseSignature } from "./release-signature";
import { TrustRoot } from "./trust-root";

let root: string;
let keys: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "nimbus-trust-"));
  await mkdir(path.join(root, "image/apps/web"), { recursive: true });
  const { trustEntry } = await ReleaseSignature.generate("own-key");
  keys = JSON.stringify({ keys: [trustEntry] });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const image = () => path.join(root, "image");

test("the image's own keys are trusted, and a test's keys file only when given", async () => {
  await writeFile(path.join(image(), "apps/web/release-keys.json"), keys);
  const own = await TrustRoot.load(image(), null);
  expect(own.ok && [...own.value.keys.keys()]).toEqual(["own-key"]);
  const { trustEntry } = await ReleaseSignature.generate("test-key");
  const file = path.join(root, "keys.json");
  await writeFile(file, JSON.stringify({ keys: [trustEntry] }));
  const injected = await TrustRoot.load(image(), file);
  expect(injected.ok && [...injected.value.keys.keys()]).toEqual(["test-key"]);
});

test("a keys file that is a link, a folder or a pipe is refused without waiting on it", async () => {
  const file = path.join(root, "keys.json");
  await writeFile(file, keys);
  await symlink(file, path.join(root, "linked.json"));
  expect(
    (await TrustRoot.load(image(), path.join(root, "linked.json"))).ok,
  ).toBe(false);
  expect((await TrustRoot.load(image(), root)).ok).toBe(false);
  const fifo = path.join(root, "keys.fifo");
  expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
  const started = Date.now();
  const piped = await TrustRoot.load(image(), fifo);
  expect(piped.ok || piped.message).toContain("not a regular file");
  expect(Date.now() - started).toBeLessThan(2_000);
});
