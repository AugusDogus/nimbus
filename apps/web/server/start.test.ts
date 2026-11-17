import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

let workspace: string;
beforeEach(async () => {
  workspace = await mkdtemp(path.join(os.tmpdir(), "nimbus-start-"));
  await mkdir(path.join(workspace, "data"));
});
afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

/** Start the server with `env` and return how it exited; it must exit on its own. */
async function start(env: Record<string, string>) {
  const child = Bun.spawn(
    [process.execPath, fileURLToPath(new URL("./start.ts", import.meta.url))],
    {
      cwd: workspace,
      env: {
        PATH: process.env.PATH ?? "",
        NODE_ENV: "production",
        NIMBUS_DATA_ROOT: path.join(workspace, "data"),
        NIMBUS_CONFIG_ROOT: path.join(workspace, "config"),
        BETTER_AUTH_SECRET: "x".repeat(32),
        // Unused: startup must stop before listening.
        PORT: String(39_000 + Math.floor(Math.random() * 1000)),
        ...env,
      },
      stdout: "ignore",
      stderr: "pipe",
    },
  );
  const timer = setTimeout(() => child.kill(), 20_000);
  const [code, stderr] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
  ]);
  clearTimeout(timer);
  return { code, stderr };
}

test("an invalid NIMBUS_MCP_ENABLED stops startup with a message naming it", async () => {
  const { code, stderr } = await start({ NIMBUS_MCP_ENABLED: "no" });
  expect(code).not.toBe(0);
  expect(stderr).toContain('NIMBUS_MCP_ENABLED is "no"');
});

test("an invalid NIMBUS_HOMES_PATH stops startup with a message naming it", async () => {
  const { code, stderr } = await start({ NIMBUS_HOMES_PATH: "../outside" });
  expect(code).not.toBe(0);
  expect(stderr).toContain("NIMBUS_HOMES_PATH must be");
});

test("a missing data root stops startup with a message naming it", async () => {
  const missing = path.join(workspace, "missing");
  const { code, stderr } = await start({ NIMBUS_DATA_ROOT: missing });
  expect(code).not.toBe(0);
  expect(stderr).toContain(`NIMBUS_DATA_ROOT is ${missing}`);
  expect(stderr).not.toContain("no such file or directory");
});
