import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** The manual handover harness must never touch an installation it was not pointed at on purpose. */
const harness = path.join(import.meta.dir, "handover-harness.ts");
let workspace: string;
beforeEach(async () => {
  workspace = await mkdtemp(path.join(os.tmpdir(), "nimbus-harness-"));
});
afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

const run = (args: string[], env: Record<string, string> = {}) => {
  const child = Bun.spawnSync([process.execPath, harness, ...args], {
    env: { PATH: process.env.PATH ?? "", ...env },
  });
  return { code: child.exitCode, output: `${child.stdout}${child.stderr}` };
};

test("is not shipped in the image", async () => {
  const ignored = (
    await Bun.file(path.join(import.meta.dir, "../.dockerignore")).text()
  ).split("\n");
  expect(ignored).toContain("scripts/handover-harness.ts");
});

test("needs an explicit base URL and test account, and never registers one", () => {
  const dataRoot = path.join(workspace, "data");
  expect(run(["prepare", "--data-root", dataRoot]).code).toBe(0);
  const missing = run([
    "run",
    "--data-root",
    dataRoot,
    "--control",
    "/nonexistent",
  ]);
  expect(missing.code).not.toBe(0);
  expect(missing.output).toContain("--base-url");
  const noPassword = run([
    "run",
    "--data-root",
    dataRoot,
    "--control",
    "/nonexistent",
    "--base-url",
    "http://127.0.0.1:9",
    "--email",
    "tester@example.test",
  ]);
  expect(noPassword.code).not.toBe(0);
  expect(noPassword.output).toContain("HARNESS_PASSWORD");
});

test("refuses a data root it did not prepare, and leaves it untouched", async () => {
  const existing = path.join(workspace, "someone's data");
  await mkdir(existing);
  await writeFile(path.join(existing, "notes.txt"), "keep");
  const refused = run(
    [
      "run",
      "--data-root",
      existing,
      "--control",
      "/nonexistent",
      "--base-url",
      "http://127.0.0.1:9",
      "--email",
      "tester@example.test",
    ],
    { HARNESS_PASSWORD: "test-password" },
  );
  expect(refused.code).not.toBe(0);
  expect(refused.output).toContain("did not prepare");
  expect(await readdir(existing)).toEqual(["notes.txt"]);
  // Prepare refuses a folder that already exists.
  expect(run(["prepare", "--data-root", existing]).code).not.toBe(0);
});
