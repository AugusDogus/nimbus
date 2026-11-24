import path from "node:path";
import { BuildInfo } from "../updates/build-info";
import {
  ReleaseManifest,
  type ReleaseManifest as Manifest,
} from "../updates/release-manifest";

/** Shared by the real-process update tests: a release built and signed as CI does it. */
export const web = path.resolve(import.meta.dir, "../..");
export const repo = path.resolve(web, "../..");

/** Mark this checkout, the built-in release, as build `sequence` of example/nimbus on edge. */
export async function writeBuiltInInfo(sequence: number) {
  const commit = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: repo })
    .stdout.toString()
    .trim();
  await Bun.write(
    BuildInfo.file(web),
    BuildInfo.encode({
      repository: "example/nimbus",
      commit,
      sequence,
      channel: "edge",
      image: "ghcr.io/example/nimbus:edge",
    }),
  );
}

/**
 * Build `sequence` by the real bundle builder into `<root>/out-<sequence>`, signed by the script
 * CI's signing job runs, with `privateKey` as key `test-key`. About a minute.
 */
export async function buildSignedRelease(
  root: string,
  sequence: number,
  privateKey: Uint8Array<ArrayBuffer>,
): Promise<{ manifest: Manifest; archive: string }> {
  const out = path.join(root, `out-${sequence}`);
  const builder = Bun.spawnSync(
    [
      process.execPath,
      "scripts/release-bundle.ts",
      "--out",
      out,
      "--sequence",
      String(sequence),
      "--repository",
      "example/nimbus",
      "--image",
      "ghcr.io/example/nimbus:edge",
    ],
    { cwd: repo, env: { ...process.env, TMPDIR: root } },
  );
  if (builder.exitCode !== 0) throw new Error(builder.stderr.toString());
  const signer = Bun.spawnSync(
    [
      process.execPath,
      "scripts/release-sign.ts",
      out,
      "--key-id",
      "test-key",
      "--repository",
      "example/nimbus",
      "--channel",
      "edge",
      "--commit",
      Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: repo })
        .stdout.toString()
        .trim(),
      "--sequence",
      String(sequence),
    ],
    {
      cwd: repo,
      env: {
        PATH: process.env.PATH ?? "",
        NIMBUS_RELEASE_SIGNING_KEY: Buffer.from(privateKey).toString("base64"),
      },
    },
  );
  if (signer.exitCode !== 0) throw new Error(signer.stderr.toString());
  const manifest = ReleaseManifest.parse(
    new Uint8Array(
      await Bun.file(path.join(out, "manifest.json")).arrayBuffer(),
    ),
  );
  if (!manifest.ok) throw new Error(manifest.error.message);
  return {
    manifest: manifest.value,
    archive: path.join(out, manifest.value.bundle.file),
  };
}
