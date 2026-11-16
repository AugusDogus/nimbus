/**
 * The search index's periodic reconciliation, for the benchmark's reconcile scenario. Run by
 * files-bench.ts inside a memory-capped cgroup over a tree in NIMBUS_DATA_ROOT. Starts the
 * real search worker, waits for its startup crawl, changes about 1% of the tree behind its
 * back, then asks for a reconciliation pass while searching continuously, and prints one
 * JSON line per phase: "ready" before the pass, then "done" with the pass duration, query
 * latencies during it, and whether the result matches a fresh crawl.
 */
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { getDataRoot } from "@nimbus/api/data-root";
import { crawl } from "@nimbus/api/search-crawler";
import { createSearchIndex } from "@nimbus/api/search-index";
import { driveUsage, searchEntries } from "@nimbus/api/search-service";
import { accessFor } from "@nimbus/api/access";
import { ensureSearchIndex, requestSearchRescan } from "../search-bridge";

const root = getDataRoot();
const reports: string[] = [];
const info = console.info.bind(console);
console.info = (...args: unknown[]) => {
  const line = args.map(String).join(" ");
  reports.push(line);
  info(line);
};
const passesReported = () =>
  reports.filter((line) => /\(reconcile\)/.test(line)).length;

ensureSearchIndex();
// Usage waits for the first complete crawl.
await driveUsage();

// About 1% of the tree changes while nothing watches: additions, deletions, resizes, and
// a folder moved into another one.
const folders = (
  await Array.fromAsync(
    new Bun.Glob("tree/g*/d*").scan({ cwd: root, onlyFiles: false }),
  )
).sort();
let changed = 0;
for (const [index, folder] of folders.entries()) {
  if (index % 100 !== 0) continue;
  const absolute = path.join(root, folder);
  await writeFile(path.join(absolute, "added.txt"), "0123456789");
  await rm(path.join(absolute, "file-0.txt"), { force: true });
  await writeFile(path.join(absolute, "file-1.txt"), "resized to be longer");
  changed += 3;
}
const [moved, into] = [folders[1], folders[2]];
if (moved && into) {
  await rename(path.join(root, moved), path.join(root, into, "moved-in"));
  await mkdir(path.join(root, moved));
  changed += 2;
}

const admin = accessFor(
  {
    id: "admin",
    name: "Admin",
    email: "admin@bench.test",
    role: "admin",
    banned: false,
  },
  [],
);
console.log(JSON.stringify({ type: "ready", changed }));
const before = passesReported();
const started = performance.now();
requestSearchRescan();
const latencies: number[] = [];
while (passesReported() === before && performance.now() - started < 600_000) {
  const asked = performance.now();
  await searchEntries(admin, "", "file-7", 20);
  latencies.push(performance.now() - asked);
  await Bun.sleep(5);
}
const elapsed = performance.now() - started;
latencies.sort((a, b) => a - b);
const reported = reports.at(-1) ?? "";
const fresh = createSearchIndex(1 << 16);
await crawl(fresh, root);
const usage = await driveUsage();
console.log(
  JSON.stringify({
    type: "done",
    passMs: Number(/in (\d+) ms/.exec(reported)?.[1] ?? elapsed),
    longestStallMs: Number(/longest pause (\d+) ms/.exec(reported)?.[1] ?? -1),
    queries: latencies.length,
    queryP50Ms: latencies[Math.floor(latencies.length / 2)] ?? 0,
    queryMaxMs: latencies.at(-1) ?? 0,
    matchesFreshCrawl: usage === fresh.bytesAt(""),
  }),
);
process.exit(0);
