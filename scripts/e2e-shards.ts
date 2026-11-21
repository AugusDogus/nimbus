// Splits the Playwright suite into CI shards balanced by recorded duration, one whole spec file
// at a time. Each shard runs with its own server, so the auth setup project runs in every shard
// as a dependency and is not planned.
//
// Usage:
//   bun scripts/e2e-shards.ts select <shard>/<count> <list-file>
//       Discover the spec files Playwright runs, plan <count> shards from
//       scripts/e2e-timings.json and fail unless every file is in exactly one shard and no shard
//       is empty. Then write shard <shard>'s files to <list-file> for
//       `playwright test --test-list` and fail unless Playwright selects exactly those files.
//   bun scripts/e2e-shards.ts summarize <report.json> <out.json>
//       Write the seconds each spec file took, from a Playwright JSON report.
//   bun scripts/e2e-shards.ts merge <summary.json>...
//       Record the durations in those summaries in scripts/e2e-timings.json.
//
// Spec files missing from the timings weigh the median recorded duration, so a new file is
// planned like any other until its time is recorded.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const timingsFile = path.join(import.meta.dir, "e2e-timings.json");
/** The project in playwright.config.ts that the others depend on. */
const setupProject = "setup";

/** Seconds each spec file takes, keyed by its path relative to Playwright's test directory. */
export type Timings = Readonly<Record<string, number>>;
export type Shard = {
  readonly files: readonly string[];
  readonly seconds: number;
};
/** One test of a Playwright JSON report, with the time all its attempts took. */
export type ReportTest = {
  readonly file: string;
  readonly project: string;
  readonly seconds: number;
};

function median(values: readonly number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle];
  const lower = sorted[middle - 1];
  if (upper === undefined) return 1;
  if (sorted.length % 2 === 1 || lower === undefined) return upper;
  return (lower + upper) / 2;
}

const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Assigns each file, heaviest first, to the shard with the least time so far. The result
 * depends only on the arguments, so every shard job computes the same plan.
 */
export function plan(
  files: readonly string[],
  timings: Timings,
  count: number,
): Shard[] {
  if (!Number.isInteger(count) || count < 1)
    throw new RangeError(
      `The shard count must be a positive integer, not ${count}.`,
    );
  const fallback = median(Object.values(timings));
  const weight = (file: string) => timings[file] ?? fallback;
  const shards = Array.from(
    { length: count },
    (): { files: string[]; seconds: number } => ({ files: [], seconds: 0 }),
  );
  const ordered = [...new Set(files)].sort(
    (a, b) => weight(b) - weight(a) || byName(a, b),
  );
  for (const file of ordered) {
    let lightest = shards[0];
    for (const shard of shards)
      if (lightest === undefined || shard.seconds < lightest.seconds)
        lightest = shard;
    if (lightest === undefined) break;
    lightest.files.push(file);
    lightest.seconds += weight(file);
  }
  return shards.map((shard) => ({
    files: [...shard.files].sort(byName),
    seconds: shard.seconds,
  }));
}

/** What keeps `shards` from running every discovered file exactly once; empty when nothing does. */
export function partitionProblems(
  discovered: readonly string[],
  shards: readonly Shard[],
): string[] {
  const problems: string[] = [];
  const owner = new Map<string, number>();
  shards.forEach((shard, index) => {
    if (shard.files.length === 0)
      problems.push(`Shard ${index + 1} has no spec files.`);
    for (const file of shard.files) {
      const other = owner.get(file);
      if (other === undefined) owner.set(file, index + 1);
      else problems.push(`${file} is in shards ${other} and ${index + 1}.`);
    }
  });
  const known = new Set(discovered);
  for (const [file, shard] of owner)
    if (!known.has(file))
      problems.push(
        `${file} is in shard ${shard}, but Playwright does not discover it.`,
      );
  for (const file of known)
    if (!owner.has(file)) problems.push(`${file} is in no shard.`);
  return problems;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function malformed(what: string): Error {
  return new Error(
    `The Playwright JSON report has a malformed ${what}. It should come from --reporter=json of the Playwright version in bun.lock; check that nothing else wrote to the report.`,
  );
}

function items(value: unknown, what: string): readonly unknown[] {
  if (!Array.isArray(value)) throw malformed(what);
  return value;
}

/** Every test in a Playwright JSON report, including those listed but not run. */
export function reportTests(report: unknown): ReportTest[] {
  if (!isRecord(report)) throw malformed("report");
  const errors = items(report.errors ?? [], "errors list");
  if (errors.length > 0)
    throw new Error(
      `Playwright reported ${errors.length} error(s) loading the tests, so the spec files it runs are unknown: ${JSON.stringify(errors).slice(0, 2000)}`,
    );
  const tests: ReportTest[] = [];
  const visit = (suite: unknown) => {
    if (!isRecord(suite)) throw malformed("suite");
    for (const spec of items(suite.specs ?? [], "specs list")) {
      if (!isRecord(spec) || typeof spec.file !== "string")
        throw malformed("spec");
      for (const test of items(spec.tests, "tests list")) {
        if (!isRecord(test) || typeof test.projectName !== "string")
          throw malformed("test");
        let milliseconds = 0;
        for (const result of items(test.results, "results list")) {
          if (!isRecord(result) || typeof result.duration !== "number")
            throw malformed("test result");
          milliseconds += result.duration;
        }
        tests.push({
          file: spec.file,
          project: test.projectName,
          seconds: milliseconds / 1000,
        });
      }
    }
    for (const child of items(suite.suites ?? [], "suites list")) visit(child);
  };
  for (const suite of items(report.suites, "suites list")) visit(suite);
  return tests;
}

/** The spec files with tests outside the setup project, sorted. */
export function specFiles(tests: readonly ReportTest[]): string[] {
  return [
    ...new Set(
      tests
        .filter((test) => test.project !== setupProject)
        .map((test) => test.file),
    ),
  ].sort(byName);
}

/** Seconds per spec file outside the setup project, to a tenth of a second. */
export function fileSeconds(tests: readonly ReportTest[]): Timings {
  const totals = new Map<string, number>();
  for (const test of tests)
    if (test.project !== setupProject)
      totals.set(test.file, (totals.get(test.file) ?? 0) + test.seconds);
  return Object.fromEntries(
    [...totals.keys()]
      .sort(byName)
      .map((file) => [file, Math.round((totals.get(file) ?? 0) * 10) / 10]),
  );
}

export function parseTimings(value: unknown, source: string): Timings {
  if (!isRecord(value))
    throw new Error(
      `${source} must hold a JSON object of spec file paths to seconds.`,
    );
  const timings: Record<string, number> = {};
  for (const [file, seconds] of Object.entries(value)) {
    if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0)
      throw new Error(
        `${source} records ${JSON.stringify(seconds)} for ${file}; durations must be non-negative numbers of seconds.`,
      );
    timings[file] = seconds;
  }
  return timings;
}

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await readFile(file, "utf8"));
}

async function writeTimings(file: string, timings: Timings) {
  const sorted = Object.fromEntries(
    Object.keys(timings)
      .sort(byName)
      .map((key) => [key, timings[key]]),
  );
  await writeFile(file, `${JSON.stringify(sorted, null, 2)}\n`);
}

/** The tests `playwright test --list` collects with `args`. */
function collect(args: readonly string[]): ReportTest[] {
  const command = [
    "bun",
    "playwright",
    "test",
    "--list",
    "--reporter=json",
    ...args,
  ];
  const child = Bun.spawnSync(command, {
    stdout: "pipe",
    stderr: "inherit",
    // The JSON reporter prints to stdout only when no output file is configured.
    env: {
      ...process.env,
      PLAYWRIGHT_JSON_OUTPUT_FILE: undefined,
      PLAYWRIGHT_JSON_OUTPUT_DIR: undefined,
      PLAYWRIGHT_JSON_OUTPUT_NAME: undefined,
    },
  });
  if (child.exitCode !== 0)
    throw new Error(
      `${command.join(" ")} exited with ${child.exitCode}; its errors are above. No tests ran.`,
    );
  return reportTests(JSON.parse(child.stdout.toString()));
}

async function select(
  shardArgument: string | undefined,
  listFile: string | undefined,
) {
  const match = /^(\d+)\/(\d+)$/.exec(shardArgument ?? "");
  const index = Number(match?.[1]);
  const count = Number(match?.[2]);
  if (!listFile || !match || index < 1 || index > count) {
    console.error(
      "Usage: bun scripts/e2e-shards.ts select <shard>/<count> <list-file>, with 1 <= shard <= count.",
    );
    return 2;
  }
  const discovered = specFiles(collect([]));
  const shards = plan(
    discovered,
    parseTimings(await readJson(timingsFile), timingsFile),
    count,
  );
  shards.forEach((shard, position) =>
    console.log(
      `Shard ${position + 1}/${count}: ${shard.files.length} files, about ${Math.round(shard.seconds)} s: ${shard.files.join(", ")}`,
    ),
  );
  const problems = partitionProblems(discovered, shards);
  if (problems.length > 0) {
    console.error(
      `The ${count} shards do not run the ${discovered.length} spec files Playwright discovers exactly once:\n${problems.join("\n")}\nNo tests ran. Lower the shard count in .github/workflows/ci.yml if there are fewer files than shards.`,
    );
    return 1;
  }
  const shard = shards[index - 1];
  if (shard === undefined) return 2;
  await writeFile(listFile, `${shard.files.join("\n")}\n`);
  const selected = collect(["--test-list", listFile]);
  const selectedFiles = specFiles(selected);
  const setupSelected = selected.some((test) => test.project === setupProject);
  if (selectedFiles.join("\n") !== shard.files.join("\n") || !setupSelected) {
    console.error(
      `Playwright selects ${selectedFiles.length} spec files from ${listFile}${setupSelected ? "" : " and not the setup project"}, but shard ${index} plans ${shard.files.length}.\nSelected: ${selectedFiles.join(", ") || "none"}\nPlanned: ${shard.files.join(", ")}\nNo tests ran. Test list paths must be relative to Playwright's test directory.`,
    );
    return 1;
  }
  return 0;
}

async function summarize(
  reportFile: string | undefined,
  outFile: string | undefined,
) {
  if (!reportFile || !outFile) {
    console.error(
      "Usage: bun scripts/e2e-shards.ts summarize <report.json> <out.json>",
    );
    return 2;
  }
  await writeTimings(
    outFile,
    fileSeconds(reportTests(await readJson(reportFile))),
  );
  return 0;
}

async function merge(summaryFiles: readonly string[]) {
  if (summaryFiles.length === 0) {
    console.error("Usage: bun scripts/e2e-shards.ts merge <summary.json>...");
    return 2;
  }
  const timings: Record<string, number> = {
    ...parseTimings(await readJson(timingsFile), timingsFile),
  };
  for (const file of summaryFiles)
    Object.assign(timings, parseTimings(await readJson(file), file));
  await writeTimings(timingsFile, timings);
  console.log(
    `Recorded the durations from ${summaryFiles.length} file(s) in ${timingsFile}.`,
  );
  return 0;
}

if (import.meta.main) {
  const [command, ...rest] = process.argv.slice(2);
  if (command === "select") process.exitCode = await select(rest[0], rest[1]);
  else if (command === "summarize")
    process.exitCode = await summarize(rest[0], rest[1]);
  else if (command === "merge") process.exitCode = await merge(rest);
  else {
    console.error(
      "Usage: bun scripts/e2e-shards.ts select <shard>/<count> <list-file> | summarize <report.json> <out.json> | merge <summary.json>...",
    );
    process.exitCode = 2;
  }
}
