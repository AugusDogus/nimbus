import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
