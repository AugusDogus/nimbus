import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ReleaseSignature } from "./release-signature";
import { TrustRoot } from "./trust-root";

let root: string;
let keys: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "nimbus-trust-"));
  await chmod(root, 0o755);
  await mkdir(path.join(root, "etc"), { mode: 0o755 });
  const { trustEntry } = await ReleaseSignature.generate("own-key");
  keys = JSON.stringify({ keys: [trustEntry] });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const load = (file: string) => TrustRoot.load("/nonexistent-image", file);

test("a keys file only root or the supervisor's user can change is trusted", async () => {
  const file = path.join(root, "etc/keys.json");
  await writeFile(file, keys, { mode: 0o644 });
  const loaded = await load(file);
  expect(loaded.ok && [...loaded.value.keys.keys()]).toEqual(["own-key"]);
});

test("a keys file others could change, or reach through a link or an open folder, is refused", async () => {
  const file = path.join(root, "etc/keys.json");
  await writeFile(file, keys, { mode: 0o644 });
  await chmod(file, 0o666);
  expect((await load(file)).ok).toBe(false);
  await chmod(file, 0o644);
  // A link in its place: whoever controls the link chooses the file.
  await symlink(file, path.join(root, "etc/linked.json"));
  expect((await load(path.join(root, "etc/linked.json"))).ok).toBe(false);
  // A folder on the way that others may write: they could swap the file's folder.
  await chmod(path.join(root, "etc"), 0o777);
  const open = await load(file);
  expect(open.ok || open.message).toContain("writable by others");
  await chmod(path.join(root, "etc"), 0o755);
  // Not a file at all.
  expect((await load(path.join(root, "etc"))).ok).toBe(false);
});
