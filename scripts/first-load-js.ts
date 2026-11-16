// Computes First Load JS per App Router page from a production build.
//
// Next 16 no longer prints First Load JS, so this script reconstructs it from
// the build manifests: the shared root chunks (`rootMainFiles` in
// build-manifest.json) plus every chunk listed in the page's client reference
// manifest `entryJSFiles` (layouts, templates, loading, error and not-found
// boundaries, and the page itself). Legacy `polyfillFiles` are excluded, as
// Next did, because modern browsers skip them. Lazy chunks loaded by
// `import()` or `next/dynamic` are not counted.
//
// Sizes are per file, then summed: gzip at level 9 and brotli at quality 11.
//
// Usage, after `bun run build`:
//   bun scripts/first-load-js.ts                     print a table
//   bun scripts/first-load-js.ts --json out.json     also write the numbers
//   bun scripts/first-load-js.ts --compare base.json compare with a saved run
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

const nextDir = path.resolve(import.meta.dir, "../apps/web/.next");

type RouteSize = {
  route: string;
  files: number;
  raw: number;
  gzip: number;
  brotli: number;
};

type Sizes = { raw: number; gzip: number; brotli: number };

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path.join(nextDir, file), "utf8"));
  } catch (error) {
    fail(
      `Could not read ${path.join(nextDir, file)}: ${error instanceof Error ? error.message : String(error)}. Run \`bun run build\` first.`,
    );
  }
}

async function entryFiles(page: string): Promise<string[]> {
  const file = path.join(
    nextDir,
    "server/app",
    `${page}_client-reference-manifest.js`,
  );
  const source = await readFile(file, "utf8");
  const sandbox: { globalThis: Record<string, unknown> } = { globalThis: {} };
  sandbox.globalThis = sandbox;
  runInNewContext(source, sandbox);
  const manifests = sandbox.globalThis.__RSC_MANIFEST;
  const manifest = isRecord(manifests) ? manifests[page] : undefined;
  const entries = isRecord(manifest) ? manifest.entryJSFiles : undefined;
  if (!isRecord(entries))
    fail(`${file} has no entryJSFiles for ${page}; the manifest format changed.`);
  return Object.values(entries).flatMap((value) =>
    isStringArray(value) ? value : [],
  );
}

const sizeCache = new Map<string, Sizes>();

async function sizeOf(file: string): Promise<Sizes> {
  const cached = sizeCache.get(file);
  if (cached) return cached;
  const bytes = await readFile(path.join(nextDir, file));
  const sizes = {
    raw: bytes.byteLength,
    gzip: gzipSync(bytes, { level: 9 }).byteLength,
    brotli: brotliCompressSync(bytes, {
      params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
    }).byteLength,
  };
  sizeCache.set(file, sizes);
  return sizes;
}

async function measure(): Promise<RouteSize[]> {
  const buildManifest = await readJson("build-manifest.json");
  const rootMainFiles = isRecord(buildManifest)
    ? buildManifest.rootMainFiles
    : undefined;
  if (!isStringArray(rootMainFiles))
    fail("build-manifest.json has no rootMainFiles array.");
  const routes = await readJson("app-path-routes-manifest.json");
  if (!isRecord(routes)) fail("app-path-routes-manifest.json is not an object.");

  const results: RouteSize[] = [];
  for (const [page, route] of Object.entries(routes)) {
    if (!page.endsWith("/page") || typeof route !== "string") continue;
    if (route.startsWith("/_")) continue;
    const files = [...new Set([...rootMainFiles, ...(await entryFiles(page))])];
    const total: Sizes = { raw: 0, gzip: 0, brotli: 0 };
    for (const file of files) {
      const sizes = await sizeOf(file);
      total.raw += sizes.raw;
      total.gzip += sizes.gzip;
      total.brotli += sizes.brotli;
    }
    results.push({ route, files: files.length, ...total });
  }
  return results.sort((a, b) => a.route.localeCompare(b.route));
}

function parseSaved(value: unknown): RouteSize[] {
  if (!Array.isArray(value)) fail("The comparison file is not an array.");
  return value.map((item) => {
    if (
      !isRecord(item) ||
      typeof item.route !== "string" ||
      typeof item.files !== "number" ||
      typeof item.raw !== "number" ||
      typeof item.gzip !== "number" ||
      typeof item.brotli !== "number"
    )
      fail("The comparison file has an entry that is not a route size.");
    return {
      route: item.route,
      files: item.files,
      raw: item.raw,
      gzip: item.gzip,
      brotli: item.brotli,
    };
  });
}

const kb = (bytes: number) => (bytes / 1000).toFixed(1);
const delta = (bytes: number) =>
  `${bytes > 0 ? "+" : ""}${(bytes / 1000).toFixed(1)}`;

const args = process.argv.slice(2);
const option = (name: string) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};

const current = await measure();
const jsonPath = option("--json");
if (jsonPath) await writeFile(jsonPath, `${JSON.stringify(current, null, 2)}\n`);

const comparePath = option("--compare");
if (comparePath) {
  const baseline = new Map(
    parseSaved(JSON.parse(await readFile(comparePath, "utf8"))).map((row) => [
      row.route,
      row,
    ]),
  );
  console.log(
    "| Route | Baseline gzip kB | Now gzip kB | Δ gzip | Baseline brotli kB | Now brotli kB | Δ brotli |",
  );
  console.log("| --- | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const row of current) {
    const base = baseline.get(row.route);
    console.log(
      base
        ? `| ${row.route} | ${kb(base.gzip)} | ${kb(row.gzip)} | ${delta(row.gzip - base.gzip)} | ${kb(base.brotli)} | ${kb(row.brotli)} | ${delta(row.brotli - base.brotli)} |`
        : `| ${row.route} | new | ${kb(row.gzip)} | | new | ${kb(row.brotli)} | |`,
    );
  }
  for (const route of baseline.keys())
    if (!current.some((row) => row.route === route))
      console.log(`| ${route} | removed | | | | | |`);
} else {
  console.log("| Route | Files | Raw kB | Gzip kB | Brotli kB |");
  console.log("| --- | ---: | ---: | ---: | ---: |");
  for (const row of current)
    console.log(
      `| ${row.route} | ${row.files} | ${kb(row.raw)} | ${kb(row.gzip)} | ${kb(row.brotli)} |`,
    );
}
