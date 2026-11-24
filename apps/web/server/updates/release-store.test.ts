import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile,
  symlink,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ReleaseManifest } from "./release-manifest";
import { ReleaseSignature, type TrustRoot } from "./release-signature";
import { MANIFEST_FILE, ReleaseStore, SIGNATURE_FILE } from "./release-store";
import { ReleaseTree } from "./release-tree";
import { testManifest } from "./updates-testing";

let releases: string;
let trust: TrustRoot;
let privateKey: Uint8Array<ArrayBuffer>;
beforeEach(async () => {
  releases = await mkdtemp(path.join(os.tmpdir(), "nimbus-releases-"));
  const key = await ReleaseSignature.generate("test-key");
  const loaded = await ReleaseSignature.trustRoot(
    new TextEncoder().encode(JSON.stringify({ keys: [key.trustEntry] })),
  );
  if (!loaded.ok) throw new Error(loaded.error.message);
  trust = loaded.value;
  privateKey = key.privateKey;
});
afterEach(async () => {
  await rm(releases, { recursive: true, force: true });
});

async function installed(sequence: number, as?: string) {
  const manifest = testManifest(sequence);
  const name = as ?? ReleaseManifest.releaseName(manifest);
  await mkdir(path.join(releases, name));
  const bytes = ReleaseManifest.encode(manifest);
  await writeFile(path.join(releases, name, MANIFEST_FILE), bytes);
  await writeFile(
    path.join(releases, name, SIGNATURE_FILE),
    await ReleaseSignature.sign(privateKey, "test-key", bytes),
  );
  return name;
}

test("the state round-trips, and a damaged state file is reported, not guessed", async () => {
  const fresh = await ReleaseStore.read(releases, ReleaseStore.empty());
  expect(fresh).toEqual({ ok: true, value: ReleaseStore.empty() });
  const state = {
    current: "edge-101-x",
    previous: null,
    pending: null,
    watermarks: { "example/nimbus edge": 101 },
    lastCheck: null,
  };
  await ReleaseStore.write(releases, state);
  expect(await ReleaseStore.read(releases, ReleaseStore.empty())).toEqual({
    ok: true,
    value: state,
  });
  await writeFile(path.join(releases, "state.json"), "{ not json");
  expect((await ReleaseStore.read(releases, ReleaseStore.empty())).ok).toBe(
    false,
  );
});

test("an installed release verifies only with its own signed manifest, under its own name", async () => {
  const name = await installed(101);
  expect((await ReleaseStore.verified(releases, name, trust)).ok).toBe(true);
  // Renamed, as a server writing here could try: the manifest names another release.
  await installed(102, "edge-109-aaaaaaaaaaaa");
  expect(
    (await ReleaseStore.verified(releases, "edge-109-aaaaaaaaaaaa", trust)).ok,
  ).toBe(false);
  await writeFile(path.join(releases, name, MANIFEST_FILE), "{}");
  expect((await ReleaseStore.verified(releases, name, trust)).ok).toBe(false);
});

test("pruning keeps the newest releases and those still needed, and removes staging leftovers", async () => {
  const names = [];
  for (const sequence of [101, 102, 103, 104, 105])
    names.push(await installed(sequence));
  await mkdir(path.join(releases, ".staging-edge-106-aaaaaaaaaaaa"));
  const [oldest = "", second = ""] = names;
  const removed = await ReleaseStore.prune(releases, new Set([oldest]));
  expect(removed.sort()).toEqual(
    [".staging-edge-106-aaaaaaaaaaaa", second].sort(),
  );
  expect((await readdir(releases)).sort()).toEqual(
    [oldest, ...names.slice(2)].sort(),
  );
});

test("an installed release is intact only as its signed tree, with natives linked to the image", async () => {
  const name = "edge-150-aaaaaaaaaaaa";
  const root = path.join(releases, name);
  await mkdir(path.join(root, "apps/web/server"), { recursive: true });
  await writeFile(path.join(root, "apps/web/server/start.ts"), "// server\n");
  await mkdir(path.join(root, "apps/web/node_modules"));
  const manifest = testManifest(150, {
    requires: { ...testManifest(150).requires, native: { sharp: "0.35.4" } },
    tree: await ReleaseTree.digest(root),
  });
  await symlink("/image/sharp", path.join(root, "apps/web/node_modules/sharp"));
  await writeFile(path.join(root, MANIFEST_FILE), "{}");
  const natives = new Map([["sharp", "/image/sharp"]]);
  expect(await ReleaseStore.intact(root, manifest, natives)).toEqual({
    ok: true,
  });
  expect(
    (
      await ReleaseStore.intact(
        root,
        manifest,
        new Map([["sharp", "/elsewhere"]]),
      )
    ).ok,
  ).toBe(false);
  await writeFile(path.join(root, "apps/web/server/start.ts"), "// changed\n");
  expect((await ReleaseStore.intact(root, manifest, natives)).ok).toBe(false);
  await writeFile(path.join(root, "apps/web/server/start.ts"), "// server\n");
  await writeFile(path.join(root, "apps/web/server/extra.ts"), "");
  expect((await ReleaseStore.intact(root, manifest, natives)).ok).toBe(false);
  await rm(path.join(root, "apps/web/server/extra.ts"));
  await rm(path.join(root, "apps/web/server/start.ts"));
  expect((await ReleaseStore.intact(root, manifest, natives)).ok).toBe(false);
});

test("pruning removes only installed releases, never other folders it finds", async () => {
  for (const sequence of [181, 182, 183, 184]) await installed(sequence);
  await mkdir(path.join(releases, "photos"));
  await mkdir(path.join(releases, "edge-1-aaaaaaaaaaaa"));
  await ReleaseStore.prune(releases, new Set());
  const left = await readdir(releases);
  expect(left).toContain("photos");
  // Named like one, but with no signed manifest: not a release this store installed.
  expect(left).toContain("edge-1-aaaaaaaaaaaa");
});
