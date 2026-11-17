// Checks that the pages with an entry of their own, sign-in and the public share and upload
// pages, load only their own code: no module of the signed-in app, at startup or later.
//
// The build records which modules each output file holds, once for the ungrouped probe build
// and once for the grouped build (see apps/web/vite/startup-chunk-groups.ts). A page's own code
// is every module its entry can import in the probe, where Rolldown never mixes modules of
// different entries in one file. A module the grouped build makes the page load beyond that is
// foreign, and fails the check.
//
// Usage, after `bun run build`:  bun scripts/page-modules.ts [--list]
import { readFile } from "node:fs/promises";
import path from "node:path";

type Chunk = {
  file: string;
  facade: string | null;
  imports: string[];
  dynamicImports: string[];
  modules: string[];
};

const cache = path.join(import.meta.dir, "../apps/web/node_modules/.cache");
const pages = ["auth.html", "share.html", "file-request.html"];
const list = process.argv.includes("--list");

const isChunk = (value: unknown): value is Chunk =>
  typeof value === "object" &&
  value !== null &&
  "file" in value &&
  typeof value.file === "string" &&
  "modules" in value &&
  Array.isArray(value.modules) &&
  "imports" in value &&
  Array.isArray(value.imports) &&
  "dynamicImports" in value &&
  Array.isArray(value.dynamicImports);

async function layout(name: "probe" | "build") {
  const file = path.join(cache, `nimbus-chunk-modules-${name}.json`);
  const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
  if (!Array.isArray(parsed) || !parsed.every(isChunk)) {
    console.error(
      `${file} is not a module layout. Run \`bun run build\` in apps/web first.`,
    );
    process.exit(1);
  }
  return new Map(parsed.map((chunk) => [chunk.file, chunk]));
}

/** The files a page loads from `start`: by static import, and also by `import()` if `later`. */
function reach(chunks: Map<string, Chunk>, start: string, later: boolean) {
  const files = new Set<string>();
  const visit = (file: string) => {
    const chunk = chunks.get(file);
    if (!chunk || files.has(file)) return;
    files.add(file);
    for (const next of chunk.imports) visit(next);
    if (later) for (const next of chunk.dynamicImports) visit(next);
  };
  visit(start);
  return files;
}

const modulesOf = (chunks: Map<string, Chunk>, files: Set<string>) =>
  new Set([...files].flatMap((file) => chunks.get(file)?.modules ?? []));

const entryFile = (chunks: Map<string, Chunk>, page: string) =>
  [...chunks.values()].find((chunk) => chunk.facade === page)?.file;

const probe = await layout("probe");
const build = await layout("build");
let foreignTotal = 0;
for (const page of pages) {
  const probeEntry = entryFile(probe, page);
  const buildEntry = entryFile(build, page);
  if (!probeEntry || !buildEntry) {
    console.error(`The build has no entry for ${page}.`);
    process.exit(1);
  }
  const own = modulesOf(probe, reach(probe, probeEntry, true));
  const startup = reach(build, buildEntry, false);
  const everything = reach(build, buildEntry, true);
  const foreign = [...modulesOf(build, everything)].filter(
    (module) => !own.has(module),
  );
  foreignTotal += foreign.length;
  console.log(
    `${page}: ${startup.size} files at startup, ${everything.size - startup.size} more after first render, ${foreign.length} modules of other pages`,
  );
  for (const module of list ? foreign : foreign.slice(0, 10))
    console.log(`  ${module}`);
}
if (foreignTotal > 0) process.exit(1);
