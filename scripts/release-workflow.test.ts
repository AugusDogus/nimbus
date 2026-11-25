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
type Job = {
  if?: string;
  environment?: string;
  needs: string[];
  /** The job as written, for what a field-by-field reading does not cover. */
  source: string;
  steps: Step[];
};

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
        needs: Array.isArray(fields.needs)
          ? fields.needs.flatMap((need) => text(need) ?? [])
          : text(fields.needs) !== undefined
            ? [String(fields.needs)]
            : [],
        source: JSON.stringify(value),
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

test("smoke and sign download the bundle's artifact to where its files were uploaded, and check them the same way", () => {
  const upload = jobs.bundle?.steps.find((one) =>
    one.uses?.startsWith("actions/upload-artifact"),
  );
  const folder = String(upload?.with?.path ?? "").replace(/\/$/, "");
  expect(folder).toBe("bundle");
  for (const name of ["smoke", "sign"]) {
    const steps = jobs[name]?.steps ?? [];
    const download = steps.find((one) =>
      one.uses?.startsWith("actions/download-artifact"),
    );
    // By id it is a multi-artifact download, nested by name unless merged.
    expect({ name, with: download?.with }).toEqual({
      name,
      with: {
        "artifact-ids": "${{ needs.bundle.outputs.artifact-id }}",
        path: folder,
        "merge-multiple": true,
      },
    });
    expect(
      steps.some(
        (one) =>
          one.run?.trim() ===
          `scripts/release-artifact-check.sh ${folder} "$MANIFEST" "$BUNDLE"`,
      ),
    ).toBe(true);
  }
});

test("the artifact check says whether a file is missing or its digest differs", async () => {
  const dir = path.join(folder, "bundle");
  const check = (manifest: string, bundle: string) => {
    const run = Bun.spawnSync([
      "sh",
      path.join(import.meta.dir, "release-artifact-check.sh"),
      dir,
      manifest,
      bundle,
    ]);
    return { code: run.exitCode, said: run.stderr.toString() };
  };
  const sha = (text: string) =>
    new Bun.CryptoHasher("sha256").update(text).digest("hex");
  // Nested under the artifact's name, as a download by id without merging leaves it.
  await Bun.write(path.join(dir, "release-bundle/manifest.json"), "{}");
  const nested = check(sha("{}"), sha("bundle"));
  expect(nested.code).toBe(1);
  expect(nested.said).toContain("manifest.json is missing");
  expect(nested.said).toContain("release-bundle");
  await Bun.write(path.join(dir, "manifest.json"), "{}");
  expect(check(sha("{}"), sha("bundle")).said).toContain("exactly one");
  await Bun.write(path.join(dir, "nimbus-edge-7.tar.gz"), "bundle");
  expect(check(sha("{}"), sha("bundle")).code).toBe(0);
  const manifest = check(sha("other"), sha("bundle"));
  expect(manifest.code).toBe(1);
  expect(manifest.said).toContain("manifest.json has SHA-256");
  const bundle = check(sha("{}"), sha("other"));
  expect(bundle.code).toBe(1);
  expect(bundle.said).toContain("nimbus-edge-7.tar.gz has SHA-256");
});

test("the bundle is built and smoke-tested from the start, and only signing waits for every check", () => {
  // Beside the checks, as the image is: nothing before it.
  expect(jobs.bundle?.needs).toEqual([]);
  expect(jobs.smoke?.needs).toEqual(["bundle"]);
  // Signing waits for verify, so for every check, and for the smoke test of what it signs.
  expect([...(jobs.sign?.needs ?? [])].sort()).toEqual([
    "bundle",
    "smoke",
    "verify",
  ]);
  expect(jobs.sign?.if).toContain(mainOnly);
  expect(jobs.sign?.if).not.toContain("workflow_dispatch");
  // The key exists in that one job only.
  const holders = Object.entries(jobs)
    .filter(([, job]) => job.source.includes("NIMBUS_RELEASE_SIGNING_KEY"))
    .map(([name]) => name);
  expect(holders).toEqual(["sign"]);
  // What it signs must say the workflow's own repository, channel, commit and sequence.
  const signs = (jobs.sign?.steps ?? []).find((one) =>
    one.run?.includes("scripts/release-sign.ts"),
  );
  for (const bound of [
    '--repository "$GITHUB_REPOSITORY"',
    "--channel edge",
    '--commit "$GITHUB_SHA"',
    '--sequence "$GITHUB_RUN_NUMBER"',
  ])
    expect(signs?.run).toContain(bound);
});

test("every real-process test runs in a job of its own, and verify waits for all of them", async () => {
  const files = (
    await Array.fromAsync(
      new Bun.Glob("*.e2e.ts").scan(
        path.join(import.meta.dir, "../apps/web/server/supervisor"),
      ),
    )
  )
    .map((file) => file.replace(/\.e2e\.ts$/, ""))
    .sort();
  const matrix = record(
    record(record(record(parsed.jobs)["real-processes"]).strategy).matrix,
  );
  const tests: string[] = Array.isArray(matrix.test)
    ? matrix.test.flatMap((one: unknown) => text(one) ?? [])
    : [];
  expect(tests.sort()).toEqual(files);
  expect(
    jobs["real-processes"]?.steps.some((one) =>
      one.run?.includes(
        "bun test ./apps/web/server/supervisor/${{ matrix.test }}.e2e.ts",
      ),
    ),
  ).toBe(true);
  // None of them waits behind the build job, or holds it up.
  expect(jobs.build?.source).not.toContain(".e2e.ts");
  for (const need of ["build", "real-processes", "e2e", "unit"])
    expect(jobs.verify?.needs).toContain(need);
});
