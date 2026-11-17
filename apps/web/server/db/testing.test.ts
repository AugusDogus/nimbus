import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

let workspace: string;
beforeEach(async () => {
  workspace = await mkdtemp(path.join(os.tmpdir(), "nimbus-test-db-"));
});
afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

test("test databases leave no database file in the working directory", async () => {
  const testing = fileURLToPath(new URL("./testing.ts", import.meta.url));
  const env = { ...process.env };
  delete env.NIMBUS_DATA_ROOT;
  delete env.NIMBUS_CONFIG_ROOT;
  delete env.DATABASE_URL;
  const child = Bun.spawn(
    [
      process.execPath,
      "--eval",
      `const { createTestDatabase } = await import(${JSON.stringify(testing)}); createTestDatabase().sqlite.close();`,
    ],
    { cwd: workspace, env, stdout: "ignore", stderr: "pipe" },
  );
  const [code, stderr] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
  ]);
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
  expect(await readdir(workspace)).toEqual([]);
});
