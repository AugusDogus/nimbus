import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ReleaseManifest } from "./release-manifest";
import { ReleaseSignature, type TrustRoot } from "./release-signature";
import { MANIFEST_FILE, ReleaseStore, SIGNATURE_FILE } from "./release-store";
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
  const fresh = await ReleaseStore.read(releases, ReleaseStore.empty(100));
  expect(fresh).toEqual({ ok: true, value: ReleaseStore.empty(100) });
  const state = {
    current: "edge-101-x",
    previous: null,
    highestRun: 101,
    lastCheck: null,
  };
  await ReleaseStore.write(releases, state);
  expect(await ReleaseStore.read(releases, ReleaseStore.empty(100))).toEqual({
    ok: true,
    value: state,
  });
  await writeFile(path.join(releases, "state.json"), "{ not json");
  expect((await ReleaseStore.read(releases, ReleaseStore.empty(100))).ok).toBe(
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
