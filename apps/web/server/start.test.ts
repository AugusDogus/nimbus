import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ServerChild } from "./server-child-testing";

let workspace: string;
beforeEach(async () => {
  workspace = await mkdtemp(path.join(os.tmpdir(), "nimbus-start-"));
  await mkdir(path.join(workspace, "data"));
});
afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

/** The environment of a server that would start. */
const valid = () => ({
  PATH: process.env.PATH ?? "",
  NODE_ENV: "production",
  NIMBUS_DATA_ROOT: path.join(workspace, "data"),
  NIMBUS_CONFIG_ROOT: path.join(workspace, "config"),
  BETTER_AUTH_SECRET: "x".repeat(32),
  BETTER_AUTH_URL: "http://nimbus.example.test",
  // Unused: startup must stop before listening.
  PORT: "0",
});

/** Start the server with `env`; it must exit on its own. */
const start = (env: Record<string, string>) =>
  ServerChild.exit({ cwd: workspace, env: { ...valid(), ...env } });

/** Exited by itself with a failure code, its output containing `message`. */
const refused = (message: string) => {
  const exit: unknown = expect.stringMatching(/^exited with code [1-9]/);
  const output: unknown = expect.stringContaining(message);
  return { exit, output };
};

test("an invalid NIMBUS_MCP_ENABLED stops startup with a message naming it", async () => {
  expect<unknown>(await start({ NIMBUS_MCP_ENABLED: "no" })).toEqual(
    refused('NIMBUS_MCP_ENABLED is "no"'),
  );
});

test("an invalid NIMBUS_HOMES_PATH stops startup with a message naming it", async () => {
  expect<unknown>(await start({ NIMBUS_HOMES_PATH: "../outside" })).toEqual(
    refused("NIMBUS_HOMES_PATH must be"),
  );
});

test("a missing data root stops startup with a message naming it", async () => {
  const missing = path.join(workspace, "missing");
  const result = await start({ NIMBUS_DATA_ROOT: missing });
  expect<unknown>(result).toEqual(refused(`NIMBUS_DATA_ROOT is ${missing}`));
  expect(result.output).not.toContain("no such file or directory");
});

test("PORT=0 without BETTER_AUTH_URL stops startup with a message naming both", async () => {
  const { BETTER_AUTH_URL: _unset, ...env } = valid();
  expect<unknown>(await ServerChild.exit({ cwd: workspace, env })).toEqual(
    refused("PORT is 0, so Nimbus would listen on a port it cannot know"),
  );
});
