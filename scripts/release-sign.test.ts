import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ReleaseManifest } from "../apps/web/server/updates/release-manifest";
import { ReleaseSignature } from "../apps/web/server/updates/release-signature";
import { testManifest } from "../apps/web/server/updates/updates-testing";

/**
 * The signing step runs in a job that holds the signing key and installs nothing, so the script
 * must need no package: it imports nothing at all.
 */
const script = path.join(import.meta.dir, "release-sign.ts");
let folder: string;
beforeEach(async () => {
  folder = await mkdtemp(path.join(os.tmpdir(), "nimbus-sign-"));
});
afterEach(async () => {
  await rm(folder, { recursive: true, force: true });
});

async function prepared(bundle: Uint8Array<ArrayBuffer>, claimed = bundle) {
  const hash = new Bun.CryptoHasher("sha256").update(claimed).digest("hex");
  const manifest = testManifest(201, {
    bundle: {
      file: "nimbus-edge-201.tar.gz",
      size: claimed.byteLength,
      sha256: hash,
    },
  });
  const bytes = ReleaseManifest.encode(manifest);
  await Bun.write(path.join(folder, "manifest.json"), bytes);
  await Bun.write(path.join(folder, manifest.bundle.file), bundle);
  return bytes;
}

const sign = (key: string) =>
  Bun.spawnSync([process.execPath, script, folder, "--key-id", "ci-key"], {
    env: { PATH: process.env.PATH ?? "", NIMBUS_RELEASE_SIGNING_KEY: key },
  });

test("it signs the exact manifest bytes once the bundle matches them", async () => {
  const { trustEntry, privateKey } = await ReleaseSignature.generate("ci-key");
  const bytes = await prepared(new TextEncoder().encode("bundle bytes"));
  const run = sign(Buffer.from(privateKey).toString("base64"));
  expect(run.exitCode).toBe(0);
  const trust = await ReleaseSignature.trustRoot(
    new TextEncoder().encode(JSON.stringify({ keys: [trustEntry] })),
  );
  if (!trust.ok) throw new Error(trust.error.message);
  const signature = new Uint8Array(
    await Bun.file(path.join(folder, "manifest.sig")).arrayBuffer(),
  );
  expect(await ReleaseSignature.verify(trust.value, bytes, signature)).toEqual({
    ok: true,
    keyId: "ci-key",
  });
});

test("a bundle that is not the one the manifest names is not signed", async () => {
  const { privateKey } = await ReleaseSignature.generate("ci-key");
  await prepared(
    new TextEncoder().encode("other bytes"),
    new TextEncoder().encode("bundle bytes"),
  );
  const run = sign(Buffer.from(privateKey).toString("base64"));
  expect(run.exitCode).not.toBe(0);
  expect(run.stderr.toString()).toContain("not the bundle the manifest names");
  expect(await Bun.file(path.join(folder, "manifest.sig")).exists()).toBe(
    false,
  );
});

test("the signing script imports nothing", async () => {
  const source = await Bun.file(script).text();
  expect(source).not.toMatch(/^\s*import\s/m);
  expect(source).not.toMatch(/\brequire\(/);
});
