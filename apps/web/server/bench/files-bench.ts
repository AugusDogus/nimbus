/**
 * File layer benchmark. Generates trees under a fresh directory in /var/tmp, runs each file
 * operation through the real code paths (tRPC callers, file operations, the SQLite drive store,
 * WebDAV and downloads over HTTP), and reports latency percentiles, throughput, peak memory,
 * SQL statements and event-loop stalls. See apps/web/README.md, "File layer benchmark".
 *
 *   bun run bench:files [--only=list,save] [--tree=200000] [--big=100000] [--out=result.json]
 *   bun run bench:files --compare=baseline.json,final.json
 */
import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { readFileSync } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { parseArgs } from "node:util";
import { gzipSync } from "node:zlib";
import type { SQL } from "drizzle-orm";

const { values: options } = parseArgs({
  options: {
    only: { type: "string" },
    tree: { type: "string", default: "200000" },
    big: { type: "string", default: "100000" },
    out: { type: "string" },
    compare: { type: "string" },
    keep: { type: "boolean", default: false },
  },
});

type Metric = {
  value: number;
  unit: string;
  better: "lower" | "higher" | "info";
};
type Results = Record<string, Metric>;

if (options.compare) {
  const [before, after] = options.compare.split(",").map((file) => {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    return isResults(parsed) ? parsed : {};
  });
  printComparison(before ?? {}, after ?? {});
  process.exit(0);
}

function isResults(value: unknown): value is Results {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function printComparison(before: Results, after: Results) {
  console.log("| Metric | Baseline | Final | Change |");
  console.log("| --- | ---: | ---: | ---: |");
  for (const name of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const a = before[name];
    const b = after[name];
    const format = (metric: Metric | undefined) =>
      metric ? `${round(metric.value)} ${metric.unit}` : "n/a";
    const change =
      a && b && a.value !== 0 && a.better !== "info"
        ? `${b.value / a.value >= 1 ? "" : "-"}${round(Math.abs(1 - b.value / a.value) * 100)}%`
        : "";
    console.log(`| ${name} | ${format(a)} | ${format(b)} | ${change} |`);
  }
}

function round(value: number) {
  return Math.abs(value) >= 100
    ? Math.round(value)
    : Math.round(value * 100) / 100;
}

// ---------------------------------------------------------------------------
// Environment. Every module that reads configuration is imported after this.

const workspace = await mkdtemp("/var/tmp/nimbus-bench-");
const dataRoot = path.join(workspace, "data");
const configRoot = path.join(workspace, "config");
await mkdir(dataRoot, { recursive: true });
await mkdir(configRoot, { recursive: true });
process.env.NIMBUS_DATA_ROOT = dataRoot;
process.env.NIMBUS_CONFIG_ROOT = configRoot;
process.env.DATABASE_URL = `file:${path.join(configRoot, "db.sqlite")}`;
process.env.BETTER_AUTH_SECRET ??=
  "benchmark-secret-benchmark-secret-0123456789";
process.env.BETTER_AUTH_URL = "http://localhost:3201";
process.env.NIMBUS_MCP_ENABLED = "false";

const webRoot = path.resolve(import.meta.dir, "../..");
const migrated = Bun.spawnSync(["bun", "server/db/migrate.ts"], {
  cwd: webRoot,
  env: process.env,
  stdout: "ignore",
  stderr: "inherit",
});
if (migrated.exitCode !== 0)
  throw new Error("Benchmark database migration failed.");

const { sql } = await import("drizzle-orm");
const dbModule = await import("../db");
const { db, client } = dbModule;
const { createDriveStore } = await import("../drive-store");
const { appRouter } = await import("@nimbus/api/routers");
const { getAccess } = await import("@nimbus/api/access");
const { resolveSafePath } = await import("@nimbus/api/safe-path");
const { purgeItem } = await import("@nimbus/api/file-operations");
const { publishFileEvent } = await import("@nimbus/api/file-events");
const { crawl } = await import("@nimbus/api/search-crawler");
const { createSearchIndex } = await import("@nimbus/api/search-index");
const { saveFileContent } = await import("../file-content");
const { startFileWatch } = await import("../watch.worker");
// Byte serving moved out of http-files.ts; load it from wherever this checkout keeps it.
const bytesModule: unknown = await import(
  path.join(
    import.meta.dir,
    (await Bun.file(path.join(import.meta.dir, "../file-response.ts")).exists())
      ? "../file-response.ts"
      : "../http-files.ts",
  )
);
function callBytes(name: string, args: unknown[]): unknown {
  const fn: unknown =
    typeof bytesModule === "object" && bytesModule !== null
      ? Reflect.get(bytesModule, name)
      : undefined;
  if (typeof fn !== "function")
    throw new Error(`No module in this checkout exports ${name}.`);
  return Reflect.apply(fn, undefined, args);
}
const httpFiles = {
  async serveFile(request: Request, target: string, access: unknown) {
    const response: unknown = await callBytes("serveFile", [
      request,
      target,
      access,
    ]);
    if (!(response instanceof Response))
      throw new Error("serveFile did not return a Response.");
    return response;
  },
  async serveZip(target: string, access: unknown) {
    const response: unknown = await callBytes("serveZip", [target, access]);
    if (!(response instanceof Response))
      throw new Error("serveZip did not return a Response.");
    return response;
  },
  streamBody(incoming: IncomingMessage) {
    const body = callBytes("streamBody", [incoming]);
    if (!(body instanceof ReadableStream))
      throw new Error("streamBody did not return a stream.");
    return body;
  },
};
const { handleWebDAV } = await import("../webdav");
// Listing caches by file, so the benchmark keeps running when a cache module is removed.
const apiSource = path.resolve(import.meta.dir, "../../../../packages/api/src");
const cacheModules: object[] = [];
for (const name of [
  "list-cache",
  "dir-list-cache",
  "stats-cache",
  "storage-cache",
  "drive-tree",
]) {
  const file = path.join(apiSource, `${name}.ts`);
  if (!(await Bun.file(file).exists())) continue;
  const loaded: unknown = await import(file);
  if (typeof loaded === "object" && loaded !== null) cacheModules.push(loaded);
}

/** Driver-agnostic statements: the libsql driver returns promises, bun:sqlite returns values. */
const run = (query: SQL) => Promise.resolve(db.run(query));
const all = <T>(query: SQL) => Promise.resolve(db.all<T>(query));

// As server/start.ts does after migrating.
await run(sql`PRAGMA journal_mode = WAL`);
/** A function exported by an API module, looked up by file so removed modules fail clearly. */
async function apiFunction(name: string, exported: string) {
  const loaded: unknown = await import(path.join(apiSource, `${name}.ts`));
  const value: unknown =
    typeof loaded === "object" && loaded !== null
      ? Reflect.get(loaded, exported)
      : undefined;
  if (typeof value !== "function")
    throw new Error(
      `packages/api/src/${name}.ts no longer exports ${exported}.`,
    );
  return (...args: unknown[]): unknown => Reflect.apply(value, undefined, args);
}

const store = createDriveStore(db);
const results: Results = {};
const record = (
  name: string,
  value: number,
  unit: string,
  better: Metric["better"] = "lower",
) => {
  results[name] = { value, unit, better };
  console.log(`  ${name}: ${round(value)} ${unit}`);
};

/** Forget every in-process cache the listing path keeps, whichever modules still exist. */
function resetCaches() {
  for (const loaded of cacheModules)
    for (const name of Object.keys(loaded)) {
      const value: unknown = Reflect.get(loaded, name);
      if (name.startsWith("reset") && typeof value === "function")
        Reflect.apply(value, undefined, []);
    }
}

// ---------------------------------------------------------------------------
// Instrumentation

let statements = 0;
/** Count SQL statements at the driver, whichever driver the db module uses. */
function instrument(target: object) {
  for (const method of [
    "execute",
    "batch",
    "executeMultiple",
    "query",
    "prepare",
    "run",
  ]) {
    const original: unknown = Reflect.get(target, method);
    if (typeof original !== "function") continue;
    Reflect.set(target, method, function (this: unknown, ...args: unknown[]) {
      statements++;
      const value: unknown = Reflect.apply(original, this, args);
      return value;
    });
  }
  const transaction: unknown = Reflect.get(target, "transaction");
  if (typeof transaction === "function")
    Reflect.set(
      target,
      "transaction",
      async function (this: unknown, ...args: unknown[]) {
        const tx: unknown = await Reflect.apply(transaction, this, args);
        if (typeof tx === "object" && tx !== null) instrument(tx);
        return tx;
      },
    );
}
instrument(client);

type Sample = { stallMaxMs: number; stallTotalMs: number; rssPeakMB: number };
/** Event-loop drift and RSS, sampled every millisecond while `work` runs. */
async function observe<T>(
  work: () => Promise<T>,
): Promise<{ value: T } & Sample> {
  Bun.gc(true);
  const startRss = process.memoryUsage.rss();
  let peak = startRss;
  let last = performance.now();
  let stallMax = 0;
  let stallTotal = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    const drift = now - last - 1;
    if (drift > 5) stallTotal += drift;
    stallMax = Math.max(stallMax, drift);
    last = now;
    peak = Math.max(peak, process.memoryUsage.rss());
  }, 1);
  try {
    const value = await work();
    return {
      value,
      stallMaxMs: stallMax,
      stallTotalMs: stallTotal,
      rssPeakMB: (peak - startRss) / 1024 / 1024,
    };
  } finally {
    clearInterval(timer);
  }
}

const percentile = (sorted: number[], p: number) =>
  sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))] ?? 0;

/** Run `operation` sequentially and record p50, p99, statements per call and stalls. */
async function latency(
  name: string,
  iterations: number,
  operation: (index: number) => Promise<unknown>,
) {
  const times: number[] = [];
  const before = statements;
  const sample = await observe(async () => {
    for (let index = 0; index < iterations; index++) {
      const started = performance.now();
      await operation(index);
      times.push(performance.now() - started);
    }
  });
  times.sort((a, b) => a - b);
  record(`${name} p50`, percentile(times, 0.5), "ms");
  record(`${name} p99`, percentile(times, 0.99), "ms");
  record(
    `${name} SQL statements/op`,
    (statements - before) / iterations,
    "stmts",
  );
  record(`${name} max stall`, sample.stallMaxMs, "ms");
}

/** Waits while less than 8 GB is available, so a benchmark never pushes the machine into swap. */
async function requireMemory() {
  for (;;) {
    const match = /MemAvailable:\s+(\d+)/.exec(
      readFileSync("/proc/meminfo", "utf8"),
    );
    const availableGB = Number(match?.[1] ?? 0) / 1024 / 1024;
    if (availableGB >= 8) return;
    console.log(`  waiting: ${availableGB.toFixed(1)} GB available, need 8 GB`);
    await Bun.sleep(10_000);
  }
}

// ---------------------------------------------------------------------------
// Fixtures

const absolute = (relative: string) => path.join(dataRoot, relative);

async function writeFiles(directory: string, count: number, bytes = 64) {
  await mkdir(absolute(directory), { recursive: true });
  const content = Buffer.alloc(bytes, 97);
  for (let start = 0; start < count; start += 256)
    await Promise.all(
      Array.from({ length: Math.min(256, count - start) }, (_, offset) =>
        writeFile(absolute(`${directory}/file-${start + offset}.txt`), content),
      ),
    );
}

/** `files` files in folders of 100, folders grouped 100 per parent. */
async function writeTree(directory: string, files: number) {
  for (let folder = 0; folder * 100 < files; folder++)
    await writeFiles(
      `${directory}/g${Math.floor(folder / 100)}/d${folder}`,
      Math.min(100, files - folder * 100),
    );
}

async function treeFiles(directory: string) {
  const found: string[] = [];
  for await (const entry of new Bun.Glob("**/*").scan({
    cwd: absolute(directory),
    onlyFiles: true,
  }))
    found.push(`${directory}/${entry}`);
  return found;
}

const versionColumns = new Set(
  (
    await all<{ name: string }>(sql`PRAGMA table_info(nimbus_file_version)`)
  ).map((row) => row.name),
);

/** One version record and hardlinked payload per file, keyed by whichever scheme the schema uses. */
async function seedHistory(files: readonly string[]) {
  const rows: string[] = [];
  const flush = async () => {
    if (!rows.length) return;
    const keyColumn = versionColumns.has("path") ? "path" : "file_key";
    await run(
      sql.raw(
        `INSERT INTO nimbus_file_version (id, ${keyColumn}, name, size, modified_at, archived_at, archived_by) VALUES ${rows.join(",")}`,
      ),
    );
    rows.length = 0;
  };
  for (const file of files) {
    const id = randomUUID();
    const payload = path.join(
      dataRoot,
      ".nimbus",
      "versions",
      id.slice(0, 2),
      id,
    );
    await mkdir(path.dirname(payload), { recursive: true });
    await link(absolute(file), payload);
    let key = file;
    if (!versionColumns.has("path")) {
      const stats = await lstat(absolute(file), { bigint: true });
      key = `${stats.ino}:${stats.birthtimeNs}`;
    }
    rows.push(
      `('${id}', '${key.replaceAll("'", "''")}', '${path.basename(file)}', 64, ${Date.now()}, ${Date.now()}, NULL)`,
    );
    if (rows.length === 500) await flush();
  }
  await flush();
}

await run(
  sql.raw(`INSERT INTO user (id, name, email, role) VALUES
    ('admin', 'Admin', 'admin@bench.test', 'admin'),
    ('member', 'Member', 'member@bench.test', 'user')`),
);
// A member with many grants: one per folder they collaborate on, plus group memberships.
await run(
  sql.raw(
    `INSERT INTO nimbus_grant (id, subject_type, subject_id, path, permission) VALUES ${Array.from(
      { length: 1000 },
      (_, index) =>
        `('g${index}', 'user', 'member', 'shared/p${index}', 'read')`,
    ).join(",")}`,
  ),
);
await run(
  sql.raw(
    `INSERT INTO nimbus_group (id, name) VALUES ${Array.from({ length: 20 }, (_, index) => `('team${index}', 'Team ${index}')`).join(",")}`,
  ),
);
await run(
  sql.raw(
    `INSERT INTO nimbus_group_member (group_id, user_id) VALUES ${Array.from({ length: 20 }, (_, index) => `('team${index}', 'member')`).join(",")}`,
  ),
);
for (const [index, folder] of [
  "lists",
  "events",
  "save",
  "other",
  "copysrc",
  "copies",
].entries())
  await store.saveGrant({
    id: `w${index}`,
    path: folder,
    subject: { type: "user", id: "member" },
    permission: "admin",
  });

const caller = (id: string, signal?: AbortSignal) =>
  appRouter.createCaller(
    {
      headers: new Headers(),
      session: { user: { id } },
      drive: store,
      preferences: {
        getUserPreferences: async () => null,
        setUserPreferences: async (_id, value) => value,
      },
    },
    { signal },
  );
const admin = caller("admin");
const member = caller("member");

const scenarios: Record<string, () => Promise<void>> = {
  async list() {
    for (const [size, iterations] of [
      [100, 50],
      [10_000, 15],
      [50_000, 6],
    ] as const) {
      const folder = `lists/n${size}`;
      await writeFiles(folder, size);
      await latency(`files.list ${size} cold`, iterations, async () => {
        resetCaches();
        await member.files.list({ path: folder, includeStats: true });
      });
      await latency(`files.list ${size} warm`, iterations, () =>
        member.files.list({ path: folder, includeStats: true }),
      );
      if (size === 50_000) {
        const entries = await member.files.list({
          path: folder,
          includeStats: true,
        });
        const started = performance.now();
        const json = JSON.stringify({ result: { data: entries } });
        const gzipped = gzipSync(json, { level: 3 });
        record(
          "files.list 50000 serialize+gzip",
          performance.now() - started,
          "ms",
        );
        record("files.list 50000 JSON", json.length / 1024, "KB");
        record("files.list 50000 gzip", gzipped.length / 1024, "KB");
      }
    }
  },

  async access() {
    await latency("getAccess (1000 grants, 20 groups)", 500, () =>
      getAccess(store, "member"),
    );
    const access = await getAccess(store, "member");
    const started = performance.now();
    for (let index = 0; index < 50_000; index++)
      access.can(`shared/p${index % 2000}/file`, "read");
    record("access.can x50000", performance.now() - started, "ms");
  },

  async safepath() {
    await mkdir(absolute("a/b/c/d/e"), { recursive: true });
    await latency("resolveSafePath depth 6", 5000, () =>
      resolveSafePath("a/b/c/d/e/file.txt"),
    );
  },

  async save() {
    await writeFiles("save", 1, 64 * 1024);
    const body = Buffer.alloc(64 * 1024, 98);
    const access = await getAccess(store, "member");
    await latency("save 64 KB (editor, versioned)", 200, () =>
      saveFileContent({
        store,
        access,
        requested: "save/file-0.txt",
        ifMatch: "*",
        body: new Response(body).body ?? new ReadableStream(),
      }),
    );
    await latency("versions.list (25 versions)", 500, () =>
      member.versions.list({ path: "save/file-0.txt" }),
    );
  },

  async rename() {
    const size = Number(options.big);
    await writeTree("big", size);
    const files = await treeFiles("big");
    await seedHistory(files);
    await latency(
      `rename folder, ${size} descendants with history`,
      3,
      (index) =>
        admin.files.rename({
          path: index % 2 ? "big-renamed" : "big",
          newName: index % 2 ? "big" : "big-renamed",
        }),
    );
    const sample = files[0]?.replace(/^big\//, "big-renamed/") ?? "";
    record(
      "history follows Nimbus rename",
      (await admin.versions.list({ path: sample })).length,
      "versions",
      "info",
    );
    // A rename made by another program, invisible to Nimbus.
    const outside = sample.replace(/\.txt$/, "-outside.txt");
    await rename(absolute(sample), absolute(outside));
    record(
      "history follows outside rename",
      (await admin.versions.list({ path: outside })).length,
      "versions",
      "info",
    );
    await rename(absolute(outside), absolute(sample));

    // Purge holds the mutation queue: measure how long unrelated mutations wait meanwhile.
    await mkdir(absolute("other"), { recursive: true });
    await latency(`trash folder, ${size} descendants`, 1, () =>
      admin.files.delete({ path: "big-renamed" }),
    );
    const [item] = await store.listTrash(null);
    if (!item) throw new Error("The benchmark folder did not reach trash.");
    const access = await getAccess(store, "admin");
    const waits: number[] = [];
    const purgeStarted = performance.now();
    const purge = purgeItem(store, access, item.id);
    await Bun.sleep(5);
    await Promise.all(
      Array.from({ length: 20 }, async (_, index) => {
        const started = performance.now();
        await member.files.createFolder({
          path: "other",
          name: `during-purge-${index}`,
        });
        waits.push(performance.now() - started);
      }),
    );
    await purge;
    record(
      `purge trash, ${size} descendants`,
      performance.now() - purgeStarted,
      "ms",
    );
    waits.sort((a, b) => a - b);
    record(
      "unrelated createFolder during purge p50",
      percentile(waits, 0.5),
      "ms",
    );
    record(
      "unrelated createFolder during purge max",
      percentile(waits, 1),
      "ms",
    );
  },

  async copy() {
    await writeTree("copysrc/tree", 10_000);
    await mkdir(absolute("copies"), { recursive: true });
    await mkdir(absolute("other"), { recursive: true });
    const waits: number[] = [];
    const started = performance.now();
    const copying = member.files.copy({
      sourcePath: "copysrc/tree",
      destinationPath: "copies",
    });
    await Bun.sleep(5);
    await Promise.all(
      Array.from({ length: 20 }, async (_, index) => {
        const begun = performance.now();
        await member.files.createFolder({
          path: "other",
          name: `during-copy-${index}`,
        });
        waits.push(performance.now() - begun);
      }),
    );
    await copying;
    record("copy folder, 10000 files", performance.now() - started, "ms");
    waits.sort((a, b) => a - b);
    record(
      "unrelated createFolder during copy max",
      percentile(waits, 1),
      "ms",
    );
  },

  async events() {
    const count = 5000;
    await writeFiles("events", count);
    const subscribers = 10;
    const controller = new AbortController();
    const received = Array.from({ length: subscribers }, () => 0);
    let done = () => {};
    const finished = new Promise<void>((resolve) => {
      done = resolve;
    });
    const consumers = await Promise.all(
      received.map(async (_, index) => {
        const iterable = await caller(
          "member",
          controller.signal,
        ).files.onChange({ path: "events" });
        const consumed = (async () => {
          try {
            for await (const event of iterable) {
              void event;
              received[index] = (received[index] ?? 0) + 1;
              if (received.every((value) => value >= count)) done();
            }
          } catch {
            // Aborted.
          }
        })();
        // Wrapped so Promise.all does not wait for the stream to end.
        return { consumed };
      }),
    );
    // Subscriptions attach asynchronously: probe until every subscriber receives events.
    while (received.some((value) => value === 0)) {
      publishFileEvent({
        path: absolute("events/file-0.txt"),
        event: "change",
        ts: Date.now(),
      });
      await Bun.sleep(50);
    }
    await Bun.sleep(200);
    received.fill(0);
    const before = statements;
    const sample = await observe(async () => {
      const started = performance.now();
      for (let index = 0; index < count; index++)
        publishFileEvent({
          path: absolute(`events/file-${index}.txt`),
          event: "change",
          ts: Date.now(),
        });
      await Promise.race([finished, Bun.sleep(120_000)]);
      return performance.now() - started;
    });
    controller.abort();
    await Promise.all(consumers.map((consumer) => consumer.consumed));
    record(
      `live updates: ${count} events x ${subscribers} subscribers`,
      sample.value,
      "ms",
    );
    record(
      "live updates delivered",
      received.reduce((a, b) => a + b, 0),
      "events",
      "info",
    );
    record(
      "live updates SQL statements/event",
      (statements - before) / count,
      "stmts",
    );
    record("live updates max stall", sample.stallMaxMs, "ms");
  },

  async watch() {
    const count = 50_000;
    await mkdir(absolute("burst"), { recursive: true });
    const seen = new Set<string>();
    let emitted = 0;
    let lastEmit = 0;
    const handle = startFileWatch(dataRoot, 300, (event) => {
      emitted++;
      seen.add(event.path);
      lastEmit = performance.now();
      publishFileEvent(event);
    });
    try {
      const sample = await observe(async () => {
        await writeFiles("burst", count);
        const written = performance.now();
        while (performance.now() - Math.max(lastEmit, written) < 2000)
          await Bun.sleep(100);
        return Math.max(0, lastEmit - written);
      });
      const expected = Array.from({ length: count }, (_, index) =>
        absolute(`burst/file-${index}.txt`),
      );
      record(
        `watcher burst ${count}: events emitted`,
        emitted,
        "events",
        "info",
      );
      record(
        `watcher burst ${count}: files missed`,
        expected.filter((file) => !seen.has(file)).length,
        "files",
      );
      record(
        `watcher burst ${count}: lag after last write`,
        sample.value,
        "ms",
      );
      record(`watcher burst ${count}: max stall`, sample.stallMaxMs, "ms");
    } finally {
      handle.close();
    }
  },

  async tree() {
    const size = Number(options.tree);
    await requireMemory();
    await writeTree("tree", size);
    Bun.gc(true);
    const heapBefore = process.memoryUsage().heapUsed;
    const index = createSearchIndex(1 << 16);
    const crawled = await observe(async () => {
      const started = performance.now();
      await crawl(index, dataRoot);
      return performance.now() - started;
    });
    Bun.gc(true);
    record(`search crawl, ${size} files`, crawled.value, "ms");
    record(
      `search index heap, ${size} files`,
      (process.memoryUsage().heapUsed - heapBefore) / 1024 / 1024,
      "MB",
    );
    record(`search crawl max stall`, crawled.stallMaxMs, "ms");
    record(`search index entries`, index.size, "entries", "info");

    resetCaches();
    const getStorageUsage = await apiFunction(
      "storage-cache",
      "getStorageUsage",
    );
    Bun.gc(true);
    const storageHeap = process.memoryUsage().heapUsed;
    const usage = await observe(async () => {
      const started = performance.now();
      await getStorageUsage();
      return performance.now() - started;
    });
    Bun.gc(true);
    record(`storage usage scan, ${size} files`, usage.value, "ms");
    record(
      `storage usage heap retained`,
      (process.memoryUsage().heapUsed - storageHeap) / 1024 / 1024,
      "MB",
    );
    record(`storage usage max stall`, usage.stallMaxMs, "ms");

    // The stats warm-up the web server starts with the watcher, with its bridge's message handler.
    const workerUrl = new URL("../stats.worker.ts", import.meta.url);
    if (await Bun.file(workerUrl).exists()) {
      const setStats = await apiFunction("stats-cache", "setStats");
      const deleteStats = await apiFunction("stats-cache", "deleteStats");
      Bun.gc(true);
      const statsHeap = process.memoryUsage().heapUsed;
      const warm = await observe(
        () =>
          new Promise<number>((resolve) => {
            const started = performance.now();
            const worker = new Worker(workerUrl, { type: "module" });
            worker.onmessage = (
              event: MessageEvent<{
                type: string;
                relativePath?: string;
                size?: number;
                mtime?: number;
              }>,
            ) => {
              const message = event.data;
              if (message.type === "stat-result" && message.relativePath)
                setStats(message.relativePath, {
                  size: message.size ?? 0,
                  mtime: message.mtime ?? 0,
                });
              else if (message.type === "stat-deleted" && message.relativePath)
                deleteStats(message.relativePath);
              else if (message.type === "warm-up-done") {
                void worker.terminate();
                resolve(performance.now() - started);
              }
            };
            worker.postMessage({ type: "warm-up", root: dataRoot });
          }),
      );
      Bun.gc(true);
      record(`stats worker warm-up, ${size} files`, warm.value, "ms");
      record(
        `stats worker heap retained`,
        (process.memoryUsage().heapUsed - statsHeap) / 1024 / 1024,
        "MB",
      );
      record(`stats worker max stall`, warm.stallMaxMs, "ms");
    }
    resetCaches();
    await rm(absolute("tree"), { recursive: true, force: true });
  },

  async http() {
    await requireMemory();
    await mkdir(absolute("http"), { recursive: true });
    const big = absolute("http/big.bin");
    Bun.spawnSync([
      "dd",
      "if=/dev/urandom",
      `of=${big}`,
      "bs=1M",
      "count=1024",
      "status=none",
    ]);
    await writeFiles("http/small", 10_000, 4096);
    const token = randomUUID();
    await store.addAppPassword({
      id: randomUUID(),
      userId: "admin",
      name: "bench",
      tokenHash: createHash("sha256").update(token).digest("hex"),
      createdAt: Date.now(),
    });
    const authorization = `Basic ${Buffer.from(`admin@bench.test:${token}`).toString("base64")}`;
    const access = await getAccess(store, "admin");
    const server = await serve(async (request) => {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/dav")) return handleWebDAV(request);
      const target = url.searchParams.get("path") ?? "";
      return url.pathname === "/zip"
        ? httpFiles.serveZip(target, access)
        : httpFiles.serveFile(request, target, access);
    });
    try {
      const base = "http://127.0.0.1:3201";
      const curl = async (args: string[]) => {
        const process = Bun.spawn(
          [
            "curl",
            "-s",
            "-o",
            "/dev/null",
            "-w",
            "%{http_code} %{size_download} %{size_upload} %{time_total}\n",
            ...args,
          ],
          {
            stdout: "pipe",
          },
        );
        const output = await new Response(process.stdout).text();
        await process.exited;
        return output
          .trim()
          .split("\n")
          .map((line) => {
            const [status, downloaded, uploaded, seconds] = line
              .split(" ")
              .map(Number);
            return {
              status: status ?? 0,
              bytes: (downloaded ?? 0) + (uploaded ?? 0),
              seconds: seconds ?? 0,
            };
          });
      };
      const throughput = async (
        name: string,
        runs: () => Promise<{ bytes: number }[]>,
      ) => {
        const sample = await observe(async () => {
          const started = performance.now();
          const transfers = await runs();
          return {
            bytes: transfers.reduce((total, item) => total + item.bytes, 0),
            ms: performance.now() - started,
          };
        });
        record(
          `${name} throughput`,
          sample.value.bytes / 1024 / 1024 / (sample.value.ms / 1000),
          "MB/s",
          "higher",
        );
        record(`${name} peak RSS growth`, sample.rssPeakMB, "MB");
        record(`${name} max stall`, sample.stallMaxMs, "ms");
      };
      await throughput("download 1 GB", () =>
        curl([`${base}/download?path=http/big.bin`]),
      );
      await throughput("download 1 GB x4 concurrent", async () =>
        (
          await Promise.all(
            Array.from({ length: 4 }, () =>
              curl([`${base}/download?path=http/big.bin`]),
            ),
          )
        ).flat(),
      );
      await throughput("download 1 GB range (second half)", () =>
        curl([
          "-H",
          "Range: bytes=536870912-",
          `${base}/download?path=http/big.bin`,
        ]),
      );
      // Many small downloads over keep-alive, 8 connections.
      const smallStarted = performance.now();
      await Promise.all(
        Array.from({ length: 8 }, (_, worker) =>
          curl(
            Array.from(
              { length: 250 },
              (_, index) =>
                `${base}/download?path=http/small/file-${worker * 250 + index}.txt`,
            ),
          ),
        ),
      );
      record(
        "download 2000 x 4 KB (8 connections)",
        performance.now() - smallStarted,
        "ms",
      );
      await throughput("WebDAV GET 1 GB", () =>
        curl([
          "-H",
          `Authorization: ${authorization}`,
          `${base}/dav/http/big.bin`,
        ]),
      );
      await throughput("WebDAV PUT 1 GB", () =>
        curl([
          "-H",
          `Authorization: ${authorization}`,
          "-T",
          big,
          `${base}/dav/http/put.bin`,
        ]),
      );
      const propfind = performance.now();
      await curl([
        "-X",
        "PROPFIND",
        "-H",
        "Depth: 1",
        "-H",
        `Authorization: ${authorization}`,
        `${base}/dav/http/small/`,
      ]);
      record(
        "WebDAV PROPFIND depth 1, 10000 entries",
        performance.now() - propfind,
        "ms",
      );
      await throughput("ZIP folder of 10000 x 4 KB", () =>
        curl([`${base}/zip?path=http/small`]),
      );
      await rm(absolute("http/small"), { recursive: true, force: true });
      await throughput("ZIP folder of one 1 GB file", () =>
        curl([`${base}/zip?path=http`]),
      );
    } finally {
      await new Promise((resolve) => server.close(resolve));
      await rm(absolute("http"), { recursive: true, force: true });
    }
  },
};

/** A node:http server that converts requests and responses exactly as server/start.ts does. */
function serve(
  handler: (request: Request) => Promise<Response>,
): Promise<Server> {
  async function* responseChunks(body: ReadableStream<Uint8Array>) {
    const reader = body.getReader();
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) return;
        yield chunk.value;
      }
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
  }
  const toRequest = (incoming: IncomingMessage) => {
    const headers = new Headers();
    for (const [key, value] of Object.entries(incoming.headers)) {
      if (Array.isArray(value))
        for (const item of value) headers.append(key, item);
      else if (value !== undefined) headers.set(key, value);
    }
    const method = incoming.method ?? "GET";
    return new Request(new URL(incoming.url ?? "/", "http://localhost:3201"), {
      method,
      headers,
      ...(method === "GET" || method === "HEAD"
        ? {}
        : { body: httpFiles.streamBody(incoming), duplex: "half" }),
    });
  };
  const server = createServer((incoming, outgoing) => {
    void (async () => {
      const response = await handler(toRequest(incoming));
      outgoing.statusCode = response.status;
      response.headers.forEach((value, key) => outgoing.setHeader(key, value));
      if (response.body)
        await pipeline(responseChunks(response.body), outgoing);
      else outgoing.end();
    })().catch((error: unknown) => {
      console.error("Benchmark request failed", error);
      outgoing.destroy();
    });
  });
  return new Promise((resolve) =>
    server.listen(3201, "127.0.0.1", () => resolve(server)),
  );
}

const selected = options.only
  ? options.only.split(",")
  : Object.keys(scenarios);
try {
  console.log(
    `Nimbus file layer benchmark in ${workspace} (Bun ${Bun.version})`,
  );
  for (const name of selected) {
    const scenario = scenarios[name];
    if (!scenario)
      throw new Error(
        `Unknown scenario "${name}". Choose from ${Object.keys(scenarios).join(", ")}.`,
      );
    console.log(`\n${name}`);
    await requireMemory();
    await scenario();
  }
  if (options.out)
    await Bun.write(options.out, JSON.stringify(results, null, 2));
} finally {
  client.close();
  if (!options.keep) await rm(workspace, { recursive: true, force: true });
}
// Watchers and workers started by imported modules must not keep the process alive.
process.exit(0);
