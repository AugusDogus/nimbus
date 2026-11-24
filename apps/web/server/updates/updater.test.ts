import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Server } from "bun";
import type { BuildInfo } from "./build-info";
import {
  ReleaseManifest,
  type ReleaseManifest as Manifest,
} from "./release-manifest";
import { ReleaseSignature, type TrustRoot } from "./release-signature";
import { ReleaseStore } from "./release-store";
import { createUpdater, type RunInstaller } from "./updater";
import { installTestRelease, testManifest } from "./updates-testing";

let scratch: string;
let releases: string;
let image: string;
let trust: TrustRoot;
let privateKey: Uint8Array<ArrayBuffer>;
let server: Server<undefined>;
const served = new Map<string, Uint8Array<ArrayBuffer>>();
const lines: string[] = [];

const build: BuildInfo = {
  repository: "example/nimbus",
  commit: "c".repeat(40),
  sequence: 100,
  channel: "edge",
  image: "ghcr.io/example/nimbus:edge",
};

beforeEach(async () => {
  scratch = await mkdtemp(path.join(os.tmpdir(), "nimbus-updater-"));
  releases = path.join(scratch, "releases");
  image = path.join(scratch, "image");
  await mkdir(path.join(image, "apps/web/node_modules/sharp"), {
    recursive: true,
  });
  await writeFile(
    path.join(image, "apps/web/node_modules/sharp/package.json"),
    JSON.stringify({ name: "sharp", version: "0.35.4" }),
  );
  const key = await ReleaseSignature.generate("test-key");
  const loaded = await ReleaseSignature.trustRoot(
    new TextEncoder().encode(JSON.stringify({ keys: [key.trustEntry] })),
  );
  if (!loaded.ok) throw new Error(loaded.error.message);
  trust = loaded.value;
  privateKey = key.privateKey;
  served.clear();
  lines.length = 0;
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const body = served.get(new URL(request.url).pathname.slice(1));
      return body
        ? new Response(body)
        : new Response("not found", { status: 404 });
    },
  });
});
afterEach(async () => {
  await server.stop(true);
  await rm(scratch, { recursive: true, force: true });
});

const natives = () =>
  new Map([["sharp", path.join(image, "apps/web/node_modules/sharp")]]);

/** A manifest of build `sequence`, with its build identity replaced by `build`. */
const release = (
  sequence: number,
  identity: Partial<Manifest["build"]> = {},
) => {
  const manifest = testManifest(sequence);
  return { ...manifest, build: { ...manifest.build, ...identity } };
};

const noInstaller: RunInstaller = async () => ({
  ok: false,
  message: "not in this test",
});

const updater = (runInstaller: RunInstaller = noInstaller) =>
  createUpdater({
    releases,
    builtIn: { root: image, build },
    source: {
      kind: "url",
      base: new URL(`http://127.0.0.1:${server.port}/`),
      origin: "configured",
    },
    trust: { ok: true, value: trust },
    supervisorProtocol: 2,
    runInstaller,
    log: (line) => lines.push(line),
  });

async function ranLast(name: string) {
  await mkdir(releases, { recursive: true });
  await ReleaseStore.write(releases, {
    ...ReleaseStore.empty(),
    current: name,
  });
}

test("boot runs the last installed release only when it is this image's repository and channel", async () => {
  const own = await installTestRelease(releases, release(101), {
    privateKey,
    natives: natives(),
  });
  await ranLast(own);
  expect((await (await updater()).startRelease())?.name).toBe(own);

  for (const identity of [
    { repository: "example/fork" },
    { channel: "stable" },
  ]) {
    const other = await installTestRelease(releases, release(102, identity), {
      privateKey,
      natives: natives(),
    });
    await ranLast(other);
    expect(await (await updater()).startRelease()).toBeNull();
    expect(lines.join("\n")).toContain(
      "identity" in identity ? "" : `${Object.values(identity)[0]}`,
    );
  }
});

test("a check offers nothing from another repository, even signed with this image's key", async () => {
  const manifest = release(150, { repository: "example/fork" });
  const bytes = ReleaseManifest.encode(manifest);
  served.set("manifest.json", bytes);
  served.set(
    "manifest.sig",
    await ReleaseSignature.sign(privateKey, "test-key", bytes),
  );
  const checked = await (await updater()).check();
  expect(checked.ok).toBe(true);
  if (checked.ok) {
    expect(checked.status.available).toBeNull();
    expect(checked.status.lastCheck?.outcome).toContain("example/fork");
  }
});

/** Serve `manifest` as the newest release, signed. */
async function offer(manifest: Manifest) {
  const bytes = ReleaseManifest.encode(manifest);
  served.set("manifest.json", bytes);
  served.set(
    "manifest.sig",
    await ReleaseSignature.sign(privateKey, "test-key", bytes),
  );
}

test("with a damaged state file the built-in release runs and nothing installs until the file is dealt with", async () => {
  const own = await installTestRelease(releases, release(101), {
    privateKey,
    natives: natives(),
  });
  await ranLast(own);
  await writeFile(path.join(releases, "state.json"), "{ damaged");
  const damaged = await updater();
  expect(await damaged.startRelease()).toBeNull();
  await offer(release(102));
  expect((await damaged.check()).ok).toBe(true);
  const refused = await damaged.install();
  expect(refused.ok || refused.message).toContain("state.json");
  expect(damaged.status().unavailable).toContain("state.json");
});

test("a release no longer newer by the time it is installed is not activated, and its sequence is reserved before it is", async () => {
  await offer(release(120));
  const reached = Promise.withResolvers<void>();
  const proceed = Promise.withResolvers<void>();
  let installs = 0;
  const slow = await updater(async () => {
    installs++;
    reached.resolve();
    await proceed.promise;
    return { ok: true, name: ReleaseManifest.releaseName(release(120)) };
  });
  expect((await slow.check()).ok).toBe(true);
  const installing = slow.install();
  await reached.promise;
  // Meanwhile a newer build ran here: 120 is no longer an update.
  const newer = await installTestRelease(releases, release(125), {
    privateKey,
    natives: natives(),
  });
  expect((await slow.resolve(newer)).ok).toBe(true);
  expect(await slow.ran(newer)).toEqual({ ok: true });
  proceed.resolve();
  const outcome = await installing;
  expect(outcome.ok || outcome.message).toContain("no longer newer");
  expect(installs).toBe(1);
  // An install that is still newer is reserved durably before the caller hands over.
  await offer(release(130));
  const fast = await updater(async () => ({
    ok: true,
    name: ReleaseManifest.releaseName(release(130)),
  }));
  expect((await fast.check()).ok).toBe(true);
  expect((await fast.install()).ok).toBe(true);
  const written = await ReleaseStore.read(releases, ReleaseStore.empty());
  expect(written.ok && written.value.watermarks["example/nimbus edge"]).toBe(
    130,
  );
});

test("a state that cannot be written fails the step that needed it, and writes never interleave", async () => {
  const own = await installTestRelease(releases, release(140), {
    privateKey,
    natives: natives(),
  });
  const writer = await updater();
  expect((await writer.resolve(own)).ok).toBe(true);
  const [first, second] = await Promise.all([
    writer.ran(own),
    writer.ran(null),
  ]);
  expect(first).toEqual({ ok: true });
  expect(second).toEqual({ ok: true });
  expect((await ReleaseStore.read(releases, ReleaseStore.empty())).ok).toBe(
    true,
  );
  await chmod(releases, 0o555);
  try {
    const failed = await writer.ran(own);
    if (process.getuid?.() !== 0) expect(failed.ok).toBe(false);
  } finally {
    await chmod(releases, 0o755);
  }
});

test("a release that was being switched to starts at boot before the last one that ran, and running it clears it", async () => {
  const before = await installTestRelease(releases, release(160), {
    privateKey,
    natives: natives(),
  });
  const target = await installTestRelease(releases, release(161), {
    privateKey,
    natives: natives(),
  });
  await mkdir(releases, { recursive: true });
  await ReleaseStore.write(releases, {
    ...ReleaseStore.empty(),
    current: before,
    pending: target,
  });
  const booted = await updater();
  expect((await booted.startRelease())?.name).toBe(target);
  expect(await booted.ran(target)).toEqual({ ok: true });
  const written = await ReleaseStore.read(releases, ReleaseStore.empty());
  expect(written.ok && written.value).toMatchObject({
    current: target,
    pending: null,
    previous: before,
  });
});

test("a release being switched to that no longer verifies is not started; the last one that ran is", async () => {
  const before = await installTestRelease(releases, release(170), {
    privateKey,
    natives: natives(),
  });
  const target = await installTestRelease(releases, release(171), {
    privateKey,
    natives: natives(),
  });
  await writeFile(
    path.join(releases, target, "apps/web/server/start.ts"),
    "// changed\n",
  );
  await ReleaseStore.write(releases, {
    ...ReleaseStore.empty(),
    current: before,
    pending: target,
  });
  expect((await (await updater()).startRelease())?.name).toBe(before);
  expect(lines.join("\n")).toContain(target);
});
