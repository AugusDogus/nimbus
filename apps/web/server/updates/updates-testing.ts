import type { ReleaseManifest } from "./release-manifest";

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
      supervisorProtocol: 2,
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
