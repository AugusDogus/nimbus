import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readiness, type ReadinessOptions } from "./health";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "nimbus-health-"));
  await mkdir(path.join(root, "data"));
  await mkdir(path.join(root, "config"));
});
afterEach(async () => {
  await chmod(root, 0o700);
  await rm(root, { recursive: true, force: true });
});

const options = (
  overrides: Partial<ReadinessOptions> = {},
): ReadinessOptions => ({
  query: async () => undefined,
  dataRoot: path.join(root, "data"),
  configRoot: path.join(root, "config"),
  timeoutMs: 1000,
  ...overrides,
});

test("readiness passes when the database answers and both roots accept writes", async () => {
  const result = await Readiness.check(options());
  expect(result).toEqual({ ready: true, failures: [] });
  // Probes leave nothing behind in either root.
  expect(await readdir(path.join(root, "data", ".nimbus"))).toEqual([]);
  expect(await readdir(path.join(root, "config"))).toEqual([]);
});

test("readiness names each failing dependency", async () => {
  const result = await Readiness.check(
    options({
      query: async () => {
        throw new Error("SQLITE_CANTOPEN");
      },
      configRoot: path.join(root, "unmounted"),
    }),
  );
  expect(result.ready).toBe(false);
  expect(result.failures.map((failure) => failure.check)).toEqual([
    "database",
    "configRoot",
  ]);
});

test("readiness fails when a root is read-only", async () => {
  if (process.getuid?.() === 0) return; // root ignores permission bits
  const readOnly = path.join(root, "config");
  await chmod(readOnly, 0o500);
  const result = await Readiness.check(options());
  expect(result.failures.map((failure) => failure.check)).toEqual([
    "configRoot",
  ]);
  await chmod(readOnly, 0o700);
});

test("readiness times out a hung dependency instead of hanging the probe", async () => {
  const result = await Readiness.check(
    options({ query: () => new Promise(() => {}), timeoutMs: 20 }),
  );
  expect(result.failures).toEqual([
    { check: "database", reason: "Timed out after 20 ms." },
  ]);
});

test("cached readiness shares one probe between concurrent callers", async () => {
  let calls = 0;
  const cached = Readiness.cached(
    () => options({ query: async () => void calls++ }),
    5000,
  );
  await Promise.all([cached(), cached(), cached()]);
  await cached();
  expect(calls).toBe(1);
});
