import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import type { CompiledIconTheme } from "./icon-theme-compiler";

/**
 * One installed icon theme on disk: a directory holding its manifest, its icons and its licence,
 * every one under a name Nimbus chose. The manifest's name carries its hash, and each icon's
 * name is its own hash, so all of them are served as immutable.
 *
 *   manifest-<hash>.json (+ .br, .gz)   <hash>.svg | <hash>.png   LICENSE.txt
 */
const servedName =
  /^(manifest-[a-f0-9]{16}\.json|[a-f0-9]{32}\.(svg|png)|LICENSE\.txt)$/;
const manifestName = /^manifest-[a-f0-9]{16}\.json$/;

const types: Record<string, string> = {
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".txt": "text/plain; charset=utf-8",
};

const manifests = new Map<string, string | null>();

/**
 * Writes `compiled` to `directory`, which must not exist yet. Everything is written to a
 * sibling first and renamed into place, so a failed install leaves nothing half-written.
 * `mode` is the new directories' mode: imports under the config root stay private to the server's
 * user, while the build's bundled sets must be readable by the unprivileged user the image's
 * server runs as, since the build runs as root.
 */
async function write(
  directory: string,
  compiled: CompiledIconTheme,
  mode: 0o750 | 0o755 = 0o750,
): Promise<{ manifest: string; bytes: number }> {
  const staging = `${directory}.staging-${randomUUID()}`;
  await mkdir(staging, { recursive: true, mode });
  try {
    const manifestJson = JSON.stringify(compiled.manifest);
    const hash = createHash("sha256")
      .update(manifestJson)
      .digest("hex")
      .slice(0, 16);
    const manifest = `manifest-${hash}.json`;
    await writeFile(path.join(staging, manifest), manifestJson);
    await writeFile(
      path.join(staging, `${manifest}.gz`),
      gzipSync(manifestJson, { level: 9 }),
    );
    await writeFile(
      path.join(staging, `${manifest}.br`),
      brotliCompressSync(manifestJson, {
        params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
      }),
    );
    for (const [name, bytes] of compiled.icons)
      await writeFile(path.join(staging, name), bytes);
    if (compiled.licence !== null)
      await writeFile(path.join(staging, "LICENSE.txt"), compiled.licence);
    await rename(staging, directory);
    manifests.set(directory, manifest);
    return { manifest, bytes: compiled.bytes + manifestJson.length };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

/** The manifest's file name in `directory`, or null when nothing is installed there. */
async function manifest(directory: string): Promise<string | null> {
  const known = manifests.get(directory);
  if (known) return known;
  const names = await readdir(directory).catch(() => []);
  const found = names.find((name) => manifestName.test(name)) ?? null;
  if (found) manifests.set(directory, found);
  return found;
}

async function remove(directory: string) {
  manifests.delete(directory);
  await rm(directory, { recursive: true, force: true });
}

export const IconThemeFiles = {
  write,
  manifest,
  remove,
  /** Whether `name` is a file an installed theme may serve; nothing else is ever read. */
  served: (name: string) => servedName.test(name),
  contentType: (name: string) =>
    types[path.extname(name)] ?? "application/octet-stream",
} as const;
