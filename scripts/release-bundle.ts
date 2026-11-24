/**
 * Builds a release bundle and its manifest (see docs/updates.md), from the committed tree and the
 * built client in this checkout:
 *
 *   bun run build
 *   bun scripts/release-bundle.ts --out <dir> --sequence <n> --channel edge \
 *     --repository <owner/name> --image <image reference> [--previous-commit <sha>]
 *
 * `<dir>` then holds manifest.json and the bundle. It installs packages, so it never sees the
 * signing key: scripts/release-sign.ts signs the manifest afterwards, in a job that installs
 * nothing, which adds manifest.sig. CI runs both for every commit to main that passes its checks.
 */
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readlink,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { BundleArchive } from "../apps/web/server/updates/bundle-archive";
import { BUNDLE_ENTRIES } from "../apps/web/server/updates/bundle-entries";
import { BuildInfo } from "../apps/web/server/updates/build-info";
import { NativeArtifacts } from "../apps/web/server/updates/native-artifacts";
import {
  ReleaseManifest,
  type ReleaseManifest as Manifest,
} from "../apps/web/server/updates/release-manifest";

const repoRoot = path.resolve(import.meta.dir, "..");
/** Packages with native binaries: the image provides them, at the version the bundle names. */
const nativePackages = ["sharp"];
const nativeStore = /^(sharp@|@img\+)/;
/** What the image leaves out too (.dockerignore), and what only development uses. */
const excluded = [
  "e2e",
  "docs",
  ".github",
  "scripts",
  "Dockerfile",
  "compose.yaml",
  "test-results",
];

const { values: args } = parseArgs({
  options: {
    out: { type: "string" },
    sequence: { type: "string" },
    channel: { type: "string", default: "edge" },
    repository: { type: "string" },
    image: { type: "string" },
    "previous-commit": { type: "string" },
  },
});

function refuse(message: string): never {
  console.error(`No bundle was built: ${message}`);
  process.exit(2);
}

async function run(command: string[], cwd: string) {
  const child = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0)
    refuse(
      `\`${command.join(" ")}\` in ${cwd} exited with code ${code}:\n${stderr.trim()}`,
    );
  return stdout;
}

const sequence = Number(args.sequence);
if (!args.out || !Number.isSafeInteger(sequence) || sequence < 1)
  refuse("pass --out <dir> and --sequence <a positive whole number>.");
if (!args.repository || !args.image)
  refuse("pass --repository <owner/name> and --image <reference>.");
const out = path.resolve(args.out);
const commit = (await run(["git", "rev-parse", "HEAD"], repoRoot)).trim();
const dist = path.join(repoRoot, "apps/web/dist");
if (!(await stat(path.join(dist, "index.html")).catch(() => null)))
  refuse(`${dist} holds no built client; run \`bun run build\` first.`);

// The committed tree, as the image's build stage sees it, plus the built client.
const stage = await mkdtemp(path.join(os.tmpdir(), "nimbus-bundle-"));
try {
  const tree = path.join(stage, "release");
  await mkdir(tree);
  await run(["sh", "-c", `git archive HEAD | tar -x -C '${tree}'`], repoRoot);
  for (const name of excluded)
    await rm(path.join(tree, name), { recursive: true, force: true });
  // Editor and agent folders, which the image leaves out too.
  for (const found of await readdir(tree, { recursive: true }))
    if (/(^|\/)\.(cursor|agents|opencode)$/.test(found))
      await rm(path.join(tree, found), { recursive: true, force: true });
  await run(["cp", "-R", dist, path.join(tree, "apps/web/dist")], repoRoot);
  await run(["bun", "install", "--frozen-lockfile", "--production"], tree);

  // What the image must provide: Bun, and each native package at the version the lockfile chose.
  const native: Record<string, string> = {};
  for (const name of nativePackages) {
    const manifest: unknown = await Bun.file(
      path.join(tree, "apps/web/node_modules", name, "package.json"),
    ).json();
    const version =
      typeof manifest === "object" && manifest !== null && "version" in manifest
        ? manifest.version
        : null;
    if (typeof version !== "string")
      refuse(`${name} has no version in the production install.`);
    native[name] = version;
  }

  // Keep only the dependency packages the server's entry points reach, as the bundler reports.
  const metafile = path.join(stage, "meta.json");
  await run(
    [
      "bun",
      "build",
      ...BUNDLE_ENTRIES,
      "--target",
      "bun",
      "--outdir",
      path.join(stage, "analysis"),
      `--metafile=${metafile}`,
      ...nativePackages.flatMap((name) => ["--external", name]),
    ],
    path.join(tree, "apps/web"),
  );
  const meta: unknown = await Bun.file(metafile).json();
  const inputs =
    typeof meta === "object" &&
    meta !== null &&
    "inputs" in meta &&
    typeof meta.inputs === "object" &&
    meta.inputs !== null
      ? Object.keys(meta.inputs)
      : refuse("the bundler wrote no inputs to its metafile.");
  const reached = new Set(
    inputs.flatMap((input) => {
      const entry = /node_modules\/\.bun\/([^/]+)\/node_modules\//.exec(
        input,
      )?.[1];
      return entry ? [entry] : [];
    }),
  );
  const store = path.join(tree, "node_modules/.bun");
  // The bundler reports only what it kept after tree-shaking; at run time each package's whole
  // module graph loads. So every kept package keeps what it declares it needs, through the
  // store's own links: its dependencies and optional dependencies. Peers are the consumer's to
  // provide, often only for types (tRPC names TypeScript), so a peer is kept only when the
  // bundler saw it imported; CI starts the bundle before publishing it, which a missing one fails.
  const closure = [...reached];
  for (let entry = closure.pop(); entry !== undefined; entry = closure.pop()) {
    const name = entry.replace(/@[^@]+$/, "").replace("+", "/");
    const own = path.join(store, entry, "node_modules", name);
    const declared: unknown = await Bun.file(path.join(own, "package.json"))
      .json()
      .catch(() => null);
    if (typeof declared !== "object" || declared === null) continue;
    const field = (key: string): string[] => {
      const value: unknown =
        key in declared ? Reflect.get(declared, key) : null;
      return typeof value === "object" && value !== null
        ? Object.keys(value)
        : [];
    };
    const needs = [...field("dependencies"), ...field("optionalDependencies")];
    for (const dependency of needs) {
      const linked = await readlink(
        path.join(store, entry, "node_modules", dependency),
      ).catch(() => null);
      const target = linked
        ? /\.bun\/([^/]+)\/node_modules\//.exec(
            path.resolve(
              path.join(store, entry, "node_modules", path.dirname(dependency)),
              linked,
            ),
          )?.[1]
        : undefined;
      if (target && !reached.has(target)) {
        reached.add(target);
        closure.push(target);
      }
    }
  }
  let removed = 0;
  for (const entry of await readdir(store)) {
    if (entry === "node_modules") continue;
    if (reached.has(entry) && !nativeStore.test(entry)) continue;
    await rm(path.join(store, entry), { recursive: true, force: true });
    removed++;
  }
  // Links into removed packages, and every .bin folder, go too.
  const prune = async (folder: string): Promise<void> => {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const absolute = path.join(folder, entry.name);
      if (entry.name === ".bin") {
        await rm(absolute, { recursive: true, force: true });
        continue;
      }
      if (entry.isSymbolicLink()) {
        const target = path.resolve(folder, await readlink(absolute));
        if (!(await lstat(target).catch(() => null))) await unlink(absolute);
        continue;
      }
      if (entry.isDirectory()) await prune(absolute);
    }
  };
  await prune(tree);
  const binaries = await NativeArtifacts.find(tree);
  if (binaries.length)
    refuse(
      `the bundle would carry native binaries (${binaries.join(", ")}), which belong to the image. Add their package to the native packages the image provides.`,
    );

  const journal: unknown = await Bun.file(
    path.join(tree, "apps/web/drizzle/meta/_journal.json"),
  ).json();
  const liveSafe: unknown = await Bun.file(
    path.join(tree, "apps/web/drizzle/live-safe.json"),
  ).json();
  const tags =
    typeof journal === "object" &&
    journal !== null &&
    "entries" in journal &&
    Array.isArray(journal.entries)
      ? journal.entries.flatMap((entry: unknown) =>
          typeof entry === "object" &&
          entry !== null &&
          "tag" in entry &&
          typeof entry.tag === "string"
            ? [entry.tag]
            : [],
        )
      : refuse("the migration journal lists no migrations.");
  const safe =
    typeof liveSafe === "object" &&
    liveSafe !== null &&
    "safeBesideOlderServer" in liveSafe &&
    Array.isArray(liveSafe.safeBesideOlderServer)
      ? liveSafe.safeBesideOlderServer.filter(
          (tag: unknown): tag is string => typeof tag === "string",
        )
      : refuse("drizzle/live-safe.json lists no migrations.");
  const protocol: unknown = await Bun.file(
    path.join(tree, "apps/web/release.json"),
  ).json();
  const supervisorProtocol =
    typeof protocol === "object" &&
    protocol !== null &&
    "supervisorProtocol" in protocol &&
    typeof protocol.supervisorProtocol === "number"
      ? protocol.supervisorProtocol
      : refuse("apps/web/release.json names no supervisor protocol.");

  const build = {
    repository: args.repository,
    commit,
    sequence,
    channel: args.channel,
    image: args.image,
  };
  await Bun.write(
    BuildInfo.file(path.join(tree, "apps/web")),
    BuildInfo.encode(build),
  );

  const previous = args["previous-commit"];
  const log = previous
    ? await run(
        [
          "git",
          "log",
          "--max-count=500",
          "--format=%H%x09%s",
          `${previous}..${commit}`,
        ],
        repoRoot,
      )
    : "";
  const notes = log
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [hash = "", ...subject] = line.split("\t");
      return { commit: hash, subject: subject.join("\t").slice(0, 500) };
    });

  await mkdir(out, { recursive: true });
  const file = `nimbus-${build.channel}-${sequence}.tar.gz`;
  const archive = await BundleArchive.write(tree, path.join(out, file));
  const manifest: Manifest = {
    format: 1,
    build: {
      sequence,
      commit,
      channel: build.channel,
      publishedAt: new Date().toISOString(),
      repository: build.repository,
    },
    notes,
    requires: {
      bun: Bun.version,
      supervisorProtocol,
      native,
      image: build.image,
    },
    migrations: { tags, liveSafe: safe },
    bundle: { file, size: archive.size, sha256: archive.sha256 },
  };
  const bytes = ReleaseManifest.encode(manifest);
  if (!ReleaseManifest.parse(bytes).ok)
    refuse("the manifest it would write does not parse.");
  await Bun.write(path.join(out, "manifest.json"), bytes);
  console.info(
    `Built ${file}: ${(archive.size / 1024 ** 2).toFixed(1)} MiB, sha256 ${archive.sha256}; ${reached.size} dependency packages kept, ${removed} removed; manifest in ${out}, not signed yet.`,
  );
} finally {
  await rm(stage, { recursive: true, force: true });
}
