import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const repository = path.resolve(import.meta.dir, "..");
const guard = path.join(import.meta.dir, "test-guard.ts");

let workspace: string;
beforeEach(async () => {
  workspace = await mkdtemp(path.join(os.tmpdir(), "nimbus-test-guard-"));
});
afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

/** Run `body` as a test file under the guard, outside the repository's own test run. */
async function guarded(body: string) {
  const file = path.join(workspace, "probe.test.ts");
  await writeFile(file, `import { test } from "bun:test";\n${body}`);
  const env = { ...process.env };
  delete env.NIMBUS_DATA_ROOT;
  delete env.NIMBUS_CONFIG_ROOT;
  delete env.DATABASE_URL;
  const child = Bun.spawn(
    [process.execPath, "test", "--preload", guard, file],
    { cwd: workspace, env, stdout: "pipe", stderr: "pipe" },
  );
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, output: stdout + stderr };
}

test("a test that imports the configured database fails before opening it", async () => {
  const database = path.join(repository, "apps/web/server/db/index.ts");
  const run = await guarded(
    `await import(${JSON.stringify(database)});\ntest("opens", () => {});`,
  );
  expect(run.code).not.toBe(0);
  expect(run.output).toContain("opens the server's configured database");
  expect(existsSync(path.join(workspace, "data"))).toBe(false);
});

test("a test that leaves a file in the repository fails the run and names it", async () => {
  const name = `test-guard-probe-${process.pid}-${Date.now()}`;
  const left = path.join(repository, name);
  try {
    const run = await guarded(
      `test("leaves a file", async () => { await Bun.write(${JSON.stringify(left)}, ""); });`,
    );
    expect(run.code).not.toBe(0);
    expect(run.output).toContain(`Tests left files in the repository: ${name}`);
  } finally {
    await rm(left, { force: true });
  }
});

test("a clean test passes under the guard", async () => {
  const run = await guarded(`test("clean", () => {});`);
  expect(run).toMatchObject({ code: 0 });
});
