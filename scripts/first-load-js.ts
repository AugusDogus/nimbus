// Computes the initial JavaScript of each page from the Vite build manifest.
//
// A page loads the app entry with its static imports, then the code-split chunk of its route
// and of every layout route around it, each with its static imports. Pages with an entry of
// their own, such as the server-rendered public share page, load that entry instead. Chunks loaded later by
// `import()`, such as dialogs and preview renderers, are not counted. The theme boot script is
// inline in the HTML and not counted either.
//
// Sizes are per file, then summed: gzip at level 9 and brotli at quality 11.
//
// Usage, after `bun run build`:
//   bun scripts/first-load-js.ts                     print a table
//   bun scripts/first-load-js.ts --json out.json     also write the numbers
//   bun scripts/first-load-js.ts --compare base.json compare with a saved run
//   bun scripts/first-load-js.ts --dist <dir>        measure another build directory
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

const args = process.argv.slice(2);
const option = (name: string) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};
const dist = path.resolve(
  option("--dist") ?? path.join(import.meta.dir, "../apps/web/dist"),
);
const routePrefix = "routes/";
const splitSuffix = "?tsr-split=component";
/** Pages with their own HTML entry instead of the app's router. */
const htmlEntries: Record<string, readonly string[]> = {
  "share.html": ["/s/$token"],
  "file-request.html": ["/r/$token"],
  "auth.html": ["/login", "/signup", "/reset-password"],
};

type RouteSize = {
  route: string;
  files: number;
  raw: number;
  gzip: number;
  brotli: number;
};

type Sizes = { raw: number; gzip: number; brotli: number };

type Chunk = { file: string; imports: string[] };

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

async function readManifest(): Promise<Map<string, Chunk>> {
  const file = path.join(dist, ".vite/manifest.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    fail(
      `Could not read ${file}: ${error instanceof Error ? error.message : String(error)}. Run \`bun run build\` first.`,
    );
  }
  if (!isRecord(parsed)) fail(`${file} is not an object.`);
  const chunks = new Map<string, Chunk>();
  for (const [key, value] of Object.entries(parsed)) {
    if (!isRecord(value) || typeof value.file !== "string")
      fail(`${file} has an entry for ${key} without a file.`);
    chunks.set(key, {
      file: value.file,
      imports: isStringArray(value.imports) ? value.imports : [],
    });
  }
  return chunks;
}

/** The JavaScript files `key` loads before it runs: itself and its static imports. */
function staticFiles(
  chunks: Map<string, Chunk>,
  key: string,
  into: Set<string>,
) {
  const chunk = chunks.get(key);
  if (!chunk) fail(`The manifest references ${key}, which it does not list.`);
  if (!chunk.file.endsWith(".js") || into.has(chunk.file)) return;
  into.add(chunk.file);
  for (const imported of chunk.imports) staticFiles(chunks, imported, into);
}

/** `routes/_authed/_files/browse/$.tsx` → `/browse/$`; pathless `_layout` segments drop out. */
function routePath(file: string) {
  const segments = file
    .slice(routePrefix.length, -".tsx".length)
    .split("/")
    .filter((segment) => !segment.startsWith("_") && segment !== "index");
  return `/${segments.join("/")}`;
}

const sizeCache = new Map<string, Sizes>();

async function sizeOf(file: string): Promise<Sizes> {
  const cached = sizeCache.get(file);
  if (cached) return cached;
  const bytes = await readFile(path.join(dist, file));
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
  const chunks = await readManifest();
  const routeFiles = [...chunks.keys()]
    .filter((key) => key.startsWith(routePrefix) && key.endsWith(splitSuffix))
    .map((key) => key.slice(0, -splitSuffix.length));
  const split = new Set(routeFiles);
  // A layout route is `x.tsx` with routes under `x/`.
  const layouts = new Set(
    routeFiles.filter((file) =>
      routeFiles.some((other) => other.startsWith(`${file.slice(0, -4)}/`)),
    ),
  );
  const results: RouteSize[] = [];
  for (const file of routeFiles) {
    if (layouts.has(file)) continue;
    const files = new Set<string>();
    staticFiles(chunks, "index.html", files);
    const parts = file.slice(0, -".tsx".length).split("/");
    for (let depth = 2; depth <= parts.length; depth++) {
      const ancestor = `${parts.slice(0, depth).join("/")}.tsx`;
      if (split.has(ancestor))
        staticFiles(chunks, ancestor + splitSuffix, files);
    }
    const total: Sizes = { raw: 0, gzip: 0, brotli: 0 };
    for (const name of files) {
      const sizes = await sizeOf(name);
      total.raw += sizes.raw;
      total.gzip += sizes.gzip;
      total.brotli += sizes.brotli;
    }
    results.push({ route: routePath(file), files: files.size, ...total });
  }
  for (const [entry, routes] of Object.entries(htmlEntries)) {
    if (!chunks.has(entry)) continue;
    const files = new Set<string>();
    staticFiles(chunks, entry, files);
    const total: Sizes = { raw: 0, gzip: 0, brotli: 0 };
    for (const name of files) {
      const sizes = await sizeOf(name);
      total.raw += sizes.raw;
      total.gzip += sizes.gzip;
      total.brotli += sizes.brotli;
    }
    for (const route of routes)
      results.push({ route, files: files.size, ...total });
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

const current = await measure();
const jsonPath = option("--json");
if (jsonPath)
  await writeFile(jsonPath, `${JSON.stringify(current, null, 2)}\n`);

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
