import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Server } from "bun";
import { BundleArchive } from "./bundle-archive";
import {
  ReleaseManifest,
  type ReleaseManifest as Manifest,
} from "./release-manifest";
import { installRelease } from "./release-installer";
import { ReleaseTree } from "./release-tree";
import { ReleaseSignature, type TrustRoot } from "./release-signature";
import type { UpdateSource } from "./update-source";
import { testManifest } from "./updates-testing";

let scratch: string;
let served: Map<string, Uint8Array<ArrayBuffer>>;
let server: Server<undefined>;
let source: Extract<UpdateSource, { kind: "url" }>;
let trust: TrustRoot;
let privateKey: Uint8Array<ArrayBuffer>;
let builtInRoot: string;

beforeEach(async () => {
  scratch = await mkdtemp(path.join(os.tmpdir(), "nimbus-install-"));
  served = new Map();
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
  source = {
    kind: "url",
    base: new URL(`http://127.0.0.1:${server.port}/`),
    origin: "configured",
  };
  const key = await ReleaseSignature.generate("test-key");
  const loaded = await ReleaseSignature.trustRoot(
    new TextEncoder().encode(JSON.stringify({ keys: [key.trustEntry] })),
  );
  if (!loaded.ok) throw new Error(loaded.error.message);
  trust = loaded.value;
  privateKey = key.privateKey;
  // The image: its built-in release provides sharp 0.35.4.
  builtInRoot = path.join(scratch, "image");
  await mkdir(path.join(builtInRoot, "apps/web"), { recursive: true });
  await writeFile(
    path.join(builtInRoot, "apps/web/build-info.json"),
    JSON.stringify({
      repository: "example/nimbus",
      commit: "c".repeat(40),
      sequence: 100,
      channel: "edge",
      image: "ghcr.io/example/nimbus:edge",
    }),
  );
  await mkdir(path.join(builtInRoot, "apps/web/node_modules/sharp"), {
    recursive: true,
  });
  await writeFile(
    path.join(builtInRoot, "apps/web/node_modules/sharp/package.json"),
    JSON.stringify({ name: "sharp", version: "0.35.4" }),
  );
});
afterEach(async () => {
  await server.stop(true);
  await rm(scratch, { recursive: true, force: true });
});

/** A release tree for `manifest`'s build, archived and served, with its signed manifest. */
async function publish(
  manifest: Manifest,
  {
    tree = async () => undefined,
    bundle = (bytes: Uint8Array<ArrayBuffer>) => bytes,
    signWith = privateKey,
  }: {
    tree?: (root: string) => Promise<void>;
    bundle?: (bytes: Uint8Array<ArrayBuffer>) => Uint8Array<ArrayBuffer>;
    signWith?: Uint8Array<ArrayBuffer>;
  } = {},
) {
  const root = path.join(
    scratch,
    `tree-${manifest.build.sequence}-${Math.random()}`,
  );
  await mkdir(path.join(root, "apps/web/server"), { recursive: true });
  await mkdir(path.join(root, "apps/web/node_modules"));
  await writeFile(path.join(root, "apps/web/server/start.ts"), "// server\n");
  await writeFile(
    path.join(root, "apps/web/release.json"),
    '{ "supervisorProtocol": 2 }\n',
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
  await tree(root);
  const archive = path.join(
    scratch,
    `${manifest.bundle.file}-${Math.random()}`,
  );
  const written = await BundleArchive.write(root, archive);
  const signed: Manifest = {
    ...manifest,
    bundle: { ...manifest.bundle, ...written },
    tree: await ReleaseTree.digest(root),
  };
  served.set(
    signed.bundle.file,
    bundle(new Uint8Array(await Bun.file(archive).arrayBuffer())),
  );
  const bytes = ReleaseManifest.encode(signed);
  return {
    manifest: signed,
    bytes,
    signature: await ReleaseSignature.sign(signWith, "test-key", bytes),
  };
}

const install = (
  published: Awaited<ReturnType<typeof publish>>,
  releases = path.join(scratch, "releases"),
) =>
  installRelease({
    releases,
    source,
    manifest: published.bytes,
    signature: published.signature,
    trust,
    builtInRoot,
    supervisorProtocol: 2,
  });

const leftovers = async () =>
  (await readdir(path.join(scratch, "releases")).catch(() => [])).filter(
    (name) => name.startsWith("."),
  );

test("a signed release is downloaded, checked and put in place, linked to the image's native packages", async () => {
  const published = await publish(testManifest(101));
  const installed = await install(published);
  expect(installed).toEqual({
    ok: true,
    name: ReleaseManifest.releaseName(published.manifest),
  });
  if (!installed.ok) return;
  const root = path.join(scratch, "releases", installed.name);
  expect(await readlink(path.join(root, "apps/web/node_modules/sharp"))).toBe(
    path.join(builtInRoot, "apps/web/node_modules/sharp"),
  );
  expect(await Bun.file(path.join(root, "release-manifest.json")).text()).toBe(
    new TextDecoder().decode(published.bytes),
  );
  expect(await leftovers()).toEqual([]);
  // Installing it again changes nothing.
  expect(await install(published)).toEqual(installed);
});

test("a bundle cut short, or longer than its manifest says, is not installed and leaves nothing", async () => {
  const short = await publish(testManifest(102), {
    bundle: (bytes) => bytes.subarray(0, bytes.byteLength - 10),
  });
  const cut = await install(short);
  expect(cut.ok).toBe(false);
  if (!cut.ok) expect(cut.error.message).toContain("cut short or changed");
  const long = await publish(testManifest(103), {
    bundle: (bytes) => {
      const longer = new Uint8Array(bytes.byteLength + 10);
      longer.set(bytes);
      return longer;
    },
  });
  const over = await install(long);
  expect(over.ok).toBe(false);
  if (!over.ok) expect(over.error.message).toContain("more than");
  expect(await leftovers()).toEqual([]);
  expect(await readdir(path.join(scratch, "releases"))).toEqual([]);
});

test("a manifest signed by another key, even with this key's id, installs nothing", async () => {
  const other = await ReleaseSignature.generate("test-key");
  const forged = await publish(testManifest(104), {
    signWith: other.privateKey,
  });
  const installed = await install(forged);
  expect(installed.ok).toBe(false);
  if (!installed.ok)
    expect(installed.error.message).toContain("does not match its manifest");
  expect(await readdir(path.join(scratch, "releases")).catch(() => [])).toEqual(
    [],
  );
});

test("a bundle that carries a native package, or describes another build, is not installed", async () => {
  const native = await publish(testManifest(105), {
    tree: async (root) => {
      await mkdir(path.join(root, "apps/web/node_modules/sharp"), {
        recursive: true,
      });
      await writeFile(
        path.join(root, "apps/web/node_modules/sharp/index.js"),
        "// native\n",
      );
    },
  });
  const carried = await install(native);
  expect(carried.ok || carried.error.message).toContain(
    "which the image provides",
  );
  const other = await publish(testManifest(106), {
    tree: async (root) => {
      await writeFile(
        path.join(root, "apps/web/build-info.json"),
        JSON.stringify({
          repository: "example/nimbus",
          commit: "f".repeat(40),
          sequence: 106,
          channel: "edge",
          image: "ghcr.io/example/nimbus:edge",
        }),
      );
    },
  });
  const mismatched = await install(other);
  expect(mismatched.ok || mismatched.error.message).toContain("another build");
  expect(await leftovers()).toEqual([]);
});

test("a release that needs a native package version the image lacks is refused before downloading", async () => {
  const manifest = testManifest(107, {
    requires: { ...testManifest(107).requires, native: { sharp: "0.36.0" } },
  });
  const published = await publish(manifest);
  served.delete(published.manifest.bundle.file);
  const installed = await install(published);
  expect(installed.ok || installed.error.message).toContain(
    "sharp 0.36.0, where this image has 0.35.4",
  );
});

test("a releases folder it cannot write installs nothing and says why", async () => {
  const releases = path.join(scratch, "locked");
  await mkdir(releases);
  await chmod(releases, 0o555);
  try {
    const installed = await install(await publish(testManifest(108)), releases);
    expect(installed.ok).toBe(false);
    if (!installed.ok && process.getuid?.() !== 0)
      expect(installed.error.message).toContain(
        "may not write the releases folder",
      );
  } finally {
    await chmod(releases, 0o755);
  }
});

test("a bundle that already holds the installer's own files, or a link where it links natives, is refused", async () => {
  const preset = await publish(testManifest(109), {
    tree: async (root) => {
      await mkdir(path.join(root, "elsewhere"), { recursive: true });
      await symlink(
        "elsewhere/manifest",
        path.join(root, "release-manifest.json"),
      );
    },
  });
  expect((await install(preset)).ok).toBe(false);
  const linked = await publish(testManifest(110), {
    tree: async (root) => {
      await mkdir(path.join(root, "modules"), { recursive: true });
      await rm(path.join(root, "apps/web/node_modules"), { recursive: true });
      await symlink("../../modules", path.join(root, "apps/web/node_modules"));
    },
  });
  const installed = await install(linked);
  expect(installed.ok || installed.error.message).toContain("is a link");
  expect(await leftovers()).toEqual([]);
});

test("a bundle carrying a native binary is refused, so a bundle stays portable", async () => {
  const native = await publish(testManifest(111), {
    tree: async (root) => {
      await mkdir(path.join(root, "node_modules/.bun/codec@1.0.0/build"), {
        recursive: true,
      });
      await writeFile(
        path.join(root, "node_modules/.bun/codec@1.0.0/build/codec.node"),
        "elf",
      );
      // A locale named "so" is not a shared object.
      await writeFile(path.join(root, "node_modules/so.js"), "// locale");
    },
  });
  const installed = await install(native);
  expect(installed.ok || installed.error.message).toContain("codec.node");
  expect(await leftovers()).toEqual([]);
});

test("two installs at once, from a mirror that serves each a different bundle, each check only their own bytes", async () => {
  const published = await publish(testManifest(112), {
    tree: async (root) => {
      await writeFile(
        path.join(root, "apps/web/server/marker.txt"),
        "the signed bundle\n",
      );
    },
  });
  const good = served.get(published.manifest.bundle.file);
  if (!good) throw new Error("nothing served");
  // The same length, other bytes: what a hostile mirror sends the second request.
  const evil = good.slice();
  evil[evil.byteLength - 100] ^= 0xff;
  let requests = 0;
  served.set(published.manifest.bundle.file, new Uint8Array(0));
  server.reload({
    fetch(request) {
      const name = new URL(request.url).pathname.slice(1);
      if (name !== published.manifest.bundle.file)
        return new Response("not found", { status: 404 });
      requests++;
      return new Response(requests % 2 === 1 ? good : evil);
    },
  });
  const [first, second] = await Promise.all([
    install(published),
    install(published),
  ]);
  const outcomes = [first, second];
  expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
  const refused = outcomes.find((outcome) => !outcome.ok);
  if (refused && !refused.ok)
    expect(refused.error.message).toContain("cut short or changed");
  const name = ReleaseManifest.releaseName(published.manifest);
  expect(
    await Bun.file(
      path.join(scratch, "releases", name, "apps/web/server/marker.txt"),
    ).text(),
  ).toBe("the signed bundle\n");
  expect(await leftovers()).toEqual([]);
});

test("a release of another repository or channel than the image's is not installed, however signed", async () => {
  for (const [sequence, other] of [
    [113, { repository: "example/fork" }],
    [114, { channel: "stable" }],
  ] as const) {
    const manifest = testManifest(sequence);
    const published = await publish({
      ...manifest,
      build: { ...manifest.build, ...other },
    });
    const installed = await install(published);
    expect(installed.ok || installed.error.message).toContain(
      "not this image's",
    );
  }
  expect(await readdir(path.join(scratch, "releases")).catch(() => [])).toEqual(
    [],
  );
});
