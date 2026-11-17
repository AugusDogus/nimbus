import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export type ReadinessCheck = "database" | "dataRoot" | "configRoot";
export type ReadinessFailure = { check: ReadinessCheck; reason: string };
export type ReadinessResult = { ready: boolean; failures: ReadinessFailure[] };
export type ReadinessOptions = {
  /** Proves the database accepts writes; resolves when it does. */
  query: () => Promise<unknown>;
  dataRoot: string;
  configRoot: string;
  timeoutMs: number;
};

function within<T>(promise: Promise<T>, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Timed out after ${timeoutMs} ms.`)),
        timeoutMs,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Prove a directory is mounted and writable without leaving anything behind. */
async function probeWritable(directory: string, root: string) {
  if (!(await stat(root)).isDirectory())
    throw new Error(`${root} is not a directory.`);
  await mkdir(directory, { recursive: true });
  const probe = path.join(directory, `.health-${randomUUID()}`);
  try {
    await writeFile(probe, "");
  } finally {
    await rm(probe, { force: true });
  }
}

async function check(options: ReadinessOptions): Promise<ReadinessResult> {
  const checks: [ReadinessCheck, () => Promise<unknown>][] = [
    ["database", options.query],
    [
      "dataRoot",
      // The root itself is checked with access(2), which reports permissions and read-only
      // mounts: a probe file there would reach the file watcher and refresh every open view.
      async () => {
        await probeWritable(
          path.join(options.dataRoot, ".nimbus"),
          options.dataRoot,
        );
        await access(options.dataRoot, constants.W_OK);
      },
    ],
    ["configRoot", () => probeWritable(options.configRoot, options.configRoot)],
  ];
  const settled = await Promise.allSettled(
    checks.map(([, run]) => within(run(), options.timeoutMs)),
  );
  const failures = settled.flatMap((result, index): ReadinessFailure[] => {
    const [name] = checks[index] ?? [];
    if (result.status === "fulfilled" || !name) return [];
    const reason =
      result.reason instanceof Error
        ? result.reason.message
        : "The check failed for an unknown reason.";
    return [{ check: name, reason }];
  });
  return { ready: failures.length === 0, failures };
}

/**
 * Health endpoints are unauthenticated, so share one probe across callers for
 * `ttlMs`. This keeps load and disk writes constant however often it is polled.
 */
function cached(options: () => ReadinessOptions, ttlMs: number) {
  let latest: { at: number; result: Promise<ReadinessResult> } | undefined;
  return () => {
    const now = Date.now();
    if (!latest || now - latest.at >= ttlMs)
      latest = { at: now, result: check(options()) };
    return latest.result;
  };
}

export const Readiness = { check, cached } as const;
