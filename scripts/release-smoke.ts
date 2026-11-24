/**
 * Starts a release bundle once as a real server before CI publishes it (see docs/updates.md):
 *
 *   bun scripts/release-smoke.ts <dir holding manifest.json and the bundle>
 *
 * The bundle keeps only the dependencies its import graph reaches; a package loaded some other
 * way would be missing, and this is where that shows. It unpacks the bundle, links this
 * checkout's native packages as an installation links the image's, starts the server on its own
 * data, and requires its health check, its built client and one of its hashed assets to answer.
 * What it starts is what the manifest names: the bundle's size and SHA-256, and the unpacked
 * tree's digest, are checked first, so the bytes tested are the bytes signed.
 */
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BundleArchive } from "../apps/web/server/updates/bundle-archive";
import { ReleaseManifest } from "../apps/web/server/updates/release-manifest";
import { ReleaseTree } from "../apps/web/server/updates/release-tree";

const repoRoot = path.resolve(import.meta.dir, "..");
const out = process.argv[2];
if (!out) {
  console.error("Usage: bun scripts/release-smoke.ts <bundle dir>");
  process.exit(2);
}
const manifest = ReleaseManifest.parse(
  new Uint8Array(await Bun.file(path.join(out, "manifest.json")).arrayBuffer()),
);
if (!manifest.ok) {
  console.error(manifest.error.message);
  process.exit(1);
}

const scratch = await mkdtemp(path.join(os.tmpdir(), "nimbus-smoke-"));
let server: ReturnType<typeof Bun.spawn> | null = null;
let failure: string | null = null;
try {
  const file = path.join(out, manifest.value.bundle.file);
  const hasher = new Bun.CryptoHasher("sha256");
  let size = 0;
  for await (const chunk of Bun.file(file).stream()) {
    hasher.update(chunk);
    size += chunk.byteLength;
  }
  const sha256 = hasher.digest("hex");
  if (
    size !== manifest.value.bundle.size ||
    sha256 !== manifest.value.bundle.sha256
  )
    throw new Error(
      `${manifest.value.bundle.file} is ${size} bytes with SHA-256 ${sha256}, not the bundle the manifest names (${manifest.value.bundle.size} bytes, ${manifest.value.bundle.sha256}); nothing was started.`,
    );
  const tree = path.join(scratch, "release");
  await mkdir(tree);
  const unpacked = await BundleArchive.unpack(
    Bun.file(path.join(out, manifest.value.bundle.file)).stream(),
    tree,
  );
  if (!unpacked.ok) throw new Error(unpacked.error.message);
  const digest = await ReleaseTree.digest(tree);
  if (digest.sha256 !== manifest.value.tree.sha256)
    throw new Error(
      "The unpacked bundle is not the tree its manifest names; nothing was started.",
    );
  for (const name of Object.keys(manifest.value.requires.native))
    await symlink(
      path.join(repoRoot, "apps/web/node_modules", name),
      path.join(tree, "apps/web/node_modules", name),
    );
  await mkdir(path.join(scratch, "data/docs"), { recursive: true });
  await mkdir(path.join(scratch, "config"));
  const probe = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data: () => undefined },
  });
  const port = probe.port;
  probe.stop(true);
  const origin = `http://127.0.0.1:${port}`;
  server = Bun.spawn([process.execPath, "server/start.ts"], {
    cwd: path.join(tree, "apps/web"),
    // Only what a server needs: nothing of the job's own environment, such as a token.
    env: {
      PATH: process.env.PATH ?? "",
      HOME: scratch,
      NODE_ENV: "production",
      PORT: String(port),
      BETTER_AUTH_URL: origin,
      BETTER_AUTH_SECRET: "release-smoke-secret-0123456789abcdef01234",
      NIMBUS_DATA_ROOT: path.join(scratch, "data"),
      NIMBUS_CONFIG_ROOT: path.join(scratch, "config"),
    },
    stdout: "inherit",
    stderr: "inherit",
  });
  const until = Date.now() + 90_000;
  for (;;) {
    const healthy = await fetch(`${origin}/api/health`, { keepalive: false })
      .then((response) => response.ok)
      .catch(() => false);
    if (healthy) break;
    if (server.exitCode !== null)
      throw new Error(
        `The bundle's server exited with code ${server.exitCode} before it was healthy.`,
      );
    if (Date.now() > until)
      throw new Error("The bundle's server was not healthy within 90 seconds.");
    await Bun.sleep(250);
  }
  const page = await fetch(`${origin}/sign-in`, {
    keepalive: false,
    redirect: "follow",
  });
  const html = await page.text();
  const asset = /\/assets\/[\w.-]+\.js/.exec(html)?.[0];
  if (!page.ok || !asset)
    throw new Error(
      `The bundle's server answered ${page.status} for a page, without its client.`,
    );
  const loaded = await fetch(`${origin}${asset}`, { keepalive: false });
  if (!loaded.ok)
    throw new Error(
      `The bundle's server answered ${loaded.status} for ${asset}.`,
    );
  console.info(
    `Release bundle ${manifest.value.bundle.file} started and served its health check, a page and ${asset}.`,
  );
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
} finally {
  server?.kill("SIGTERM");
  await server?.exited;
  await rm(scratch, { recursive: true, force: true });
}
if (failure) {
  console.error(
    `The release bundle failed its smoke test, so it must not be published: ${failure}`,
  );
  process.exit(1);
}
