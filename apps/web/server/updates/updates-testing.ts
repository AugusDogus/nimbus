import { PROTOCOL_VERSION } from "../supervisor/protocol";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  ReleaseManifest as Manifest,
  type ReleaseManifest,
} from "./release-manifest";
import { ReleaseSignature } from "./release-signature";
import { MANIFEST_FILE, SIGNATURE_FILE } from "./release-store";
import { ReleaseTree } from "./release-tree";

/** A valid manifest for build `sequence`, with `overrides` on top. Tests only. */
export function testManifest(
  sequence: number,
  overrides: Partial<ReleaseManifest> = {},
): ReleaseManifest {
  const commit = sequence.toString(16).padStart(40, "a");
  return {
    format: 1,
    build: {
      sequence,
      commit,
      channel: "edge",
      publishedAt: "2026-11-24T10:00:00.000Z",
      repository: "example/nimbus",
    },
    notes: [{ commit, subject: "Show the build in settings" }],
    requires: {
      bun: "1.4.4",
      supervisorProtocol: PROTOCOL_VERSION,
      native: { sharp: "0.35.4" },
      image: "ghcr.io/example/nimbus:edge",
    },
    migrations: { tags: ["0000_initial"], liveSafe: [] },
    bundle: {
      file: `nimbus-edge-${sequence}.tar.gz`,
      size: 1234,
      sha256: "0".repeat(64),
    },
    tree: { sha256: "1".repeat(64), entries: 1 },
    ...overrides,
  };
}

/**
 * Release `manifest` installed in `releases` as the installer leaves one: its tree (a server
 * entry, its protocol and build metadata), signed with `privateKey` as `keyId`, its native
 * packages linked to `natives`. Returns its name. Tests only.
 */
export async function installTestRelease(
  releases: string,
  manifest: ReleaseManifest,
  {
    privateKey,
    keyId = "test-key",
    natives,
  }: {
    privateKey: Uint8Array<ArrayBuffer>;
    keyId?: string;
    natives: ReadonlyMap<string, string>;
  },
) {
  const name = Manifest.releaseName(manifest);
  const root = path.join(releases, name);
  await mkdir(path.join(root, "apps/web/server"), { recursive: true });
  await mkdir(path.join(root, "apps/web/node_modules"));
  await writeFile(path.join(root, "apps/web/server/start.ts"), "// server\n");
  await writeFile(
    path.join(root, "apps/web/release.json"),
    `{ "supervisorProtocol": ${manifest.requires.supervisorProtocol} }\n`,
  );
  await writeFile(
    path.join(root, "apps/web/build-info.json"),
    JSON.stringify({
      repository: manifest.build.repository,
      commit: manifest.build.commit,
      sequence: manifest.build.sequence,
      channel: manifest.build.channel,
      image: manifest.requires.image,
    }),
  );
  const signed: ReleaseManifest = {
    ...manifest,
    tree: await ReleaseTree.digest(root),
  };
  for (const native of Object.keys(signed.requires.native)) {
    const location = natives.get(native);
    if (location)
      await symlink(location, path.join(root, "apps/web/node_modules", native));
  }
  const bytes = Manifest.encode(signed);
  await writeFile(path.join(root, MANIFEST_FILE), bytes);
  await writeFile(
    path.join(root, SIGNATURE_FILE),
    await ReleaseSignature.sign(privateKey, keyId, bytes),
  );
  return name;
}
