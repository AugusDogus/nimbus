import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** The release jobs as the workflow defines them, checked for what a branch run cannot show. */
type Step = {
  uses?: string;
  run?: string;
  if?: string;
  with?: Record<string, unknown>;
};
type Job = { if?: string; environment?: string; steps: Step[] };

const text = (value: unknown) =>
  typeof value === "string" ? value : undefined;
const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {};
const asStep = (value: unknown): Step => {
  const fields = record(value);
  return {
    uses: text(fields.uses),
    run: text(fields.run),
    if: text(fields.if),
    with: fields.with === undefined ? undefined : record(fields.with),
  };
};
const parsed = record(
  Bun.YAML.parse(
    await Bun.file(
      path.join(import.meta.dir, "../.github/workflows/ci.yml"),
    ).text(),
  ),
);
const jobs: Record<string, Job> = Object.fromEntries(
  Object.entries(record(parsed.jobs)).map(([name, value]) => {
    const fields = record(value);
    return [
      name,
      {
        if: text(fields.if),
        environment: text(fields.environment),
        steps: Array.isArray(fields.steps) ? fields.steps.map(asStep) : [],
      },
    ];
  }),
);
const mainOnly =
  "github.event_name == 'push' && github.ref == 'refs/heads/main'";

test("the smoke job has the harness and its locked dependencies, so it can pass", () => {
  const smoke = jobs.smoke;
  if (!smoke) throw new Error("There is no smoke job.");
  const checkout = smoke.steps.find((one) =>
    one.uses?.startsWith("actions/checkout"),
  );
  expect(checkout?.with?.["sparse-checkout"]).toBeUndefined();
  const runs = smoke.steps.map((one) => one.run ?? "");
  const install = runs.findIndex((run) =>
    run.includes("bun install --frozen-lockfile"),
  );
  const started = runs.findIndex((run) =>
    run.includes("scripts/release-smoke.ts"),
  );
  expect(install).toBeGreaterThanOrEqual(0);
  expect(started).toBeGreaterThan(install);
});

test("a manual branch run builds and smoke-tests, and only pushes to main attest, sign or publish", () => {
  expect(jobs.bundle?.if).toContain("workflow_dispatch");
  expect(jobs.sign?.if).toContain(mainOnly);
  expect(jobs.sign?.environment).toBe("release-signing");
  const attest = jobs.bundle?.steps.find((one) =>
    one.uses?.startsWith("actions/attest-build-provenance"),
  );
  expect(attest?.if).toContain(mainOnly);
  const sign = jobs.sign?.steps ?? [];
  const guard = sign.findIndex((one) => one.run?.includes("release-newest.sh"));
  const publish = sign.findIndex((one) =>
    one.run?.includes("gh release upload"),
  );
  expect(guard).toBeGreaterThanOrEqual(0);
  expect(publish).toBeGreaterThan(guard);
  expect(sign[publish]?.if).toContain("steps.newest.outputs.publish == 'true'");
});

let folder: string;
beforeEach(async () => {
  folder = await mkdtemp(path.join(os.tmpdir(), "nimbus-newest-"));
});
afterEach(async () => {
  await rm(folder, { recursive: true, force: true });
});

const guard = async (built: unknown, published: unknown | null) => {
  const ours = path.join(folder, "ours.json");
  const theirs = path.join(folder, "theirs.json");
  await Bun.write(ours, JSON.stringify(built));
  await Bun.write(theirs, published === null ? "" : JSON.stringify(published));
  const run = Bun.spawnSync([
    "sh",
    path.join(import.meta.dir, "release-newest.sh"),
    ours,
    theirs,
  ]);
  return { code: run.exitCode, out: run.stdout.toString().trim() };
};

test("a late older run never replaces the newer release, nor another manifest of the same build", async () => {
  const build = (sequence: number, notes = "a") => ({
    build: { sequence },
    notes,
  });
  expect(await guard(build(5), null)).toEqual({ code: 0, out: "publish=true" });
  expect(await guard(build(5), build(4))).toEqual({
    code: 0,
    out: "publish=true",
  });
  expect(await guard(build(5), build(5))).toEqual({
    code: 0,
    out: "publish=false",
  });
  expect((await guard(build(5), build(6))).code).toBe(1);
  expect((await guard(build(5, "a"), build(5, "b"))).code).toBe(1);
});
