/**
 * Search benchmark: builds the filename index in process over a generated,
 * drive-shaped tree and measures each query class for an admin and for a user
 * with a handful of grants, plus build, memory, compaction, one rename and
 * 10,000 creations, and scores the labeled relevance cases.
 *
 *   bun run bench:search [--sizes=100000,1000000] [--out=result.json]
 *   bun run bench:search --compare=baseline.json,final.json
 *
 * Run it inside a memory cap, as every heavy run on this machine:
 *   systemd-run --user --scope -p MemoryMax=8G -p MemorySwapMax=0 -- bun run bench:search
 * Pin it to four cores with `taskset -c 0-3` in front of `bun`.
 *
 * The request carries the engine's newer options (depth, history); an engine
 * that predates them ignores them, so the same file measures the baseline.
 */
import { parseArgs } from "node:util";
import { availableParallelism } from "node:os";
import { createSearchIndex } from "@nimbus/api/search-index";
import {
  createScanPool,
  POOL_MIN_BYTES,
  searchWithPool,
} from "@nimbus/api/search-scan-pool";
import {
  pathAt,
  plantedFiles,
  plantedHistory,
  queryClasses,
  queryClassNames,
  relevanceCases,
  userGrants,
  type QueryClass,
} from "./search-corpus";

const { values: options } = parseArgs({
  options: {
    sizes: { type: "string", default: "100000,1000000" },
    out: { type: "string" },
    compare: { type: "string" },
    label: { type: "string", default: "" },
    /** Scan workers; 0 scans on the benchmark's own thread. */
    threads: { type: "string", default: "0" },
    /** Smallest scan handed to the workers, in name bytes. */
    "min-bytes": { type: "string" },
  },
});

type Distribution = { p50: number; p95: number; p99: number; samples: number };
type ClassResult = {
  scope: "admin" | "user";
  queryClass: QueryClass;
  depth: string;
  latency: Distribution;
  /** Total matches over one sweep of the class, to confirm equal work. */
  matches: number;
};
type RelevanceResult = {
  task: string;
  query: string;
  expected: string;
  scope: "admin" | "user";
  /** 1-based rank of the expected result in the first 50, or null when absent. */
  rank: number | null;
};
type SizeResult = {
  entries: number;
  buildMs: number;
  compactMs: number;
  rssMiB: number;
  heapMiB: number;
  renameMs: Distribution;
  create10kMs: number;
  queries: ClassResult[];
  relevance: RelevanceResult[];
};
type Results = {
  label: string;
  bun: string;
  parallelism: number;
  threads: number;
  sizes: SizeResult[];
};

const round = (value: number) =>
  value >= 100
    ? Math.round(value)
    : value >= 10
      ? Math.round(value * 10) / 10
      : Math.round(value * 1000) / 1000;

function distribution(samples: number[]): Distribution {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (p: number) =>
    sorted[
      Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
    ] ?? 0;
  return {
    p50: round(at(50)),
    p95: round(at(95)),
    p99: round(at(99)),
    samples: sorted.length,
  };
}

const memory = () => {
  Bun.gc(true);
  const usage = process.memoryUsage();
  return { rss: usage.rss, heap: usage.heapUsed };
};

const isResults = (value: unknown): value is Results =>
  typeof value === "object" &&
  value !== null &&
  "sizes" in value &&
  Array.isArray(value.sizes);

async function readResults(file: string) {
  const parsed: unknown = await Bun.file(file).json();
  if (!isResults(parsed))
    throw new Error(
      `${file} is not a search benchmark result. Pass two files written by --out.`,
    );
  return parsed;
}

function compare(before: Results, after: Results) {
  console.log(
    `| Measure | ${before.label || "before"} | ${after.label || "after"} |`,
  );
  console.log("| --- | ---: | ---: |");
  for (const size of after.sizes) {
    const old = before.sizes.find((item) => item.entries === size.entries);
    const row = (name: string, a: unknown, b: unknown) =>
      console.log(
        `| ${size.entries} ${name} | ${String(a ?? "n/a")} | ${String(b)} |`,
      );
    row("build ms", old?.buildMs, size.buildMs);
    row("compact ms", old?.compactMs, size.compactMs);
    row("RSS MiB", old?.rssMiB, size.rssMiB);
    row("rename p50 ms", old?.renameMs.p50, size.renameMs.p50);
    row("10k creations ms", old?.create10kMs, size.create10kMs);
    for (const query of size.queries) {
      const match = old?.queries.find(
        (item) =>
          item.scope === query.scope &&
          item.queryClass === query.queryClass &&
          item.depth === query.depth,
      );
      const format = (value: ClassResult | undefined) =>
        value
          ? `${value.latency.p50}/${value.latency.p95}/${value.latency.p99} (${value.matches})`
          : undefined;
      row(
        `${query.scope} ${query.queryClass} ${query.depth} p50/p95/p99 (matches)`,
        format(match),
        format(query),
      );
    }
    const score = (items: RelevanceResult[] | undefined, scope: string) => {
      const scoped = items?.filter((item) => item.scope === scope) ?? [];
      if (!scoped.length) return undefined;
      const reciprocal = scoped.reduce(
        (sum, item) => sum + (item.rank === null ? 0 : 1 / item.rank),
        0,
      );
      const top = (k: number) =>
        scoped.filter((item) => item.rank !== null && item.rank <= k).length;
      return `MRR ${round(reciprocal / scoped.length)}, @1 ${top(1)}/${scoped.length}, @5 ${top(5)}/${scoped.length}`;
    };
    for (const scope of ["admin", "user"])
      row(
        `relevance ${scope}`,
        score(old?.relevance, scope),
        score(size.relevance, scope),
      );
  }
}

if (options.compare) {
  const [first, second] = options.compare.split(",");
  if (!first || !second)
    throw new Error(
      "--compare takes two result files: --compare=a.json,b.json",
    );
  compare(await readResults(first), await readResults(second));
  process.exit(0);
}

/** The engine's request, with the options a newer engine understands. */
type BenchRequest = {
  query: string;
  root: string;
  limit: number;
  scope: { type: "all" } | { type: "grants"; paths: readonly string[] };
  depth?: "instant" | "full";
  history?: readonly {
    path: string;
    openedAt: number;
    visits: number;
    starred: boolean;
  }[];
};
type BenchAnswer = {
  hits: { path: string }[];
  truncated: boolean;
  total?: number;
};
type BenchIndex = {
  readonly size: number;
  add: (relative: string, kind: "file" | "dir", size?: number) => number;
  remove: (relative: string) => void;
  compact: () => void;
  maybeCompact: () => void;
  search: (request: BenchRequest) => BenchAnswer | Promise<BenchAnswer>;
};

const now = () => performance.now();
const threads = Number(options.threads);
if (!Number.isInteger(threads) || threads < 0)
  throw new Error(
    `--threads takes a whole number of scan workers, not "${options.threads}".`,
  );
const minBytes =
  options["min-bytes"] === undefined
    ? POOL_MIN_BYTES
    : Number(options["min-bytes"]);
const pool =
  threads > 0
    ? createScanPool(
        () => new Worker(new URL("../search-scan.worker.ts", import.meta.url)),
        threads,
      )
    : null;
const admin = { type: "all" } as const;
const user = { type: "grants", paths: userGrants } as const;
const scopes = [
  ["admin", admin],
  ["user", user],
] as const;
const depths = ["instant", "full"] as const;
const LIMIT = 50;

async function measureSize(entries: number): Promise<SizeResult> {
  const before = memory();
  const started = now();
  const real = createSearchIndex(1 << 16);
  const index: BenchIndex = real;
  for (const planted of plantedFiles) index.add(planted, "file", 1000);
  let generated = 0;
  while (index.size < entries) {
    index.add(pathAt(generated), "file", 1 + (generated % 100_000));
    generated++;
    if (generated % 50_000 === 0) index.maybeCompact();
  }
  const compactStarted = now();
  index.compact();
  const compactMs = now() - compactStarted;
  const buildMs = now() - started;
  const after = memory();
  console.log(
    `${entries} entries from ${generated} generated paths: build ${Math.round(buildMs)} ms, RSS +${Math.round((after.rss - before.rss) / 2 ** 20)} MiB`,
  );

  const queries: ClassResult[] = [];
  const search = async (request: BenchRequest): Promise<BenchAnswer> => {
    if (!pool) return index.search(request);
    const answer = await searchWithPool(() => real, request, pool, minBytes);
    if (!answer)
      throw new Error("A benchmark search was stopped; none run concurrently.");
    return answer;
  };
  for (const [scopeName, scope] of scopes)
    for (const depth of depths)
      for (const queryClass of queryClassNames) {
        const list = queryClasses[queryClass];
        const ask = (query: string) =>
          search({ query, root: "", limit: LIMIT, scope, depth });
        for (let warm = 0; warm < 2; warm++)
          for (const query of list) await ask(query);
        let matches = 0;
        for (const query of list) {
          const answer = await ask(query);
          matches += answer.total ?? answer.hits.length;
        }
        const samples: number[] = [];
        for (let repeat = 0; repeat < 10; repeat++)
          for (const query of list) {
            const asked = now();
            await ask(query);
            samples.push(now() - asked);
          }
        queries.push({
          scope: scopeName,
          queryClass,
          depth,
          latency: distribution(samples),
          matches,
        });
        console.log(
          `  ${scopeName} ${depth} ${queryClass}: ${JSON.stringify(distribution(samples))} matches ${matches}`,
        );
      }

  const history = plantedHistory.map((path, order) => ({
    path,
    openedAt: Date.now() - order * 60_000,
    visits: 3,
    starred: false,
  }));
  const relevance: RelevanceResult[] = [];
  for (const [scopeName, scope] of scopes)
    for (const item of relevanceCases) {
      const answer = await search({
        query: item.query,
        root: "",
        limit: 50,
        scope,
        depth: "full",
        history: item.history ? history : [],
      });
      const position = answer.hits.findIndex(
        (hit) => hit.path === item.expected,
      );
      relevance.push({
        task: item.task,
        query: item.query,
        expected: item.expected,
        scope: scopeName,
        rank: position < 0 ? null : position + 1,
      });
    }
  console.log(
    `  relevance: ${relevance.map((item) => `${item.scope}:${item.query}=${item.rank ?? "-"}`).join(", ")}`,
  );

  // One rename: the file leaves its name and arrives under another.
  const renames: number[] = [];
  for (let i = 0; i < 100; i++) {
    const from = pathAt(i);
    const to = `${from}.renamed`;
    const asked = now();
    index.remove(from);
    index.add(to, "file", 1);
    index.maybeCompact();
    renames.push(now() - asked);
  }
  const createStarted = now();
  for (let i = 0; i < 10_000; i++)
    index.add(`Incoming/batch-${i % 100}/new-file-${i}.txt`, "file", 10);
  index.maybeCompact();
  const create10kMs = now() - createStarted;

  return {
    entries: index.size,
    buildMs: Math.round(buildMs),
    compactMs: Math.round(compactMs),
    rssMiB: Math.round((after.rss - before.rss) / 2 ** 20),
    heapMiB: Math.round((after.heap - before.heap) / 2 ** 20),
    renameMs: distribution(renames),
    create10kMs: round(create10kMs),
    queries,
    relevance,
  };
}

const results: Results = {
  label: options.label ?? "",
  bun: Bun.version,
  parallelism: availableParallelism(),
  threads,
  sizes: [],
};
for (const size of (options.sizes ?? "").split(",").map(Number)) {
  if (!Number.isInteger(size) || size <= 0)
    throw new Error(`--sizes takes positive entry counts, not "${size}".`);
  results.sizes.push(await measureSize(size));
}
if (options.out) await Bun.write(options.out, JSON.stringify(results, null, 2));
pool?.close();
