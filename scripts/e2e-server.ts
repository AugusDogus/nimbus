import { randomBytes } from "node:crypto";
import { openSync } from "node:fs";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const port = process.env.NIMBUS_E2E_PORT ?? "3100";
const origin = `http://localhost:${port}`;
const temporary = await mkdtemp(path.join(os.tmpdir(), "nimbus-e2e-"));
const app = path.resolve(import.meta.dir, "../apps/web");
const data = path.join(temporary, "data");
const config = path.join(temporary, "config");
await mkdir(data);
await cp(path.join(app, "e2e/fixtures/data-root"), data, { recursive: true });
const manifest = path.join(os.tmpdir(), `nimbus-e2e-${port}.json`);
await writeFile(manifest, JSON.stringify({ dataRoot: data }));
// CI builds first. Exercise that build without compilation delays during tests. Locally the
// development server and Vite run, on a Vite port derived from the test port.
const production = process.env.CI === "true";
// CI keeps the server's output in a file to upload when a test fails; Playwright drops its stdout.
const logFile = process.env.NIMBUS_E2E_SERVER_LOG;
const output = logFile ? openSync(logFile, "a") : "inherit";
const child = Bun.spawn(
  ["bun", production ? "server/start.ts" : "server/dev.ts"],
  {
    cwd: app,
    stdout: output,
    stderr: output,
    env: {
      ...process.env,
      NODE_ENV: production ? "production" : "development",
      NIMBUS_VITE_PORT:
        process.env.NIMBUS_E2E_VITE_PORT ?? String(Number(port) + 10_000),
      PORT: port,
      BETTER_AUTH_URL: origin,
      BETTER_AUTH_TRUSTED_ORIGINS: origin,
      BETTER_AUTH_SECRET: randomBytes(32).toString("base64url"),
      DATABASE_URL: undefined,
      NIMBUS_DATA_ROOT: data,
      NIMBUS_CONFIG_ROOT: config,
      NIMBUS_TRUSTED_PROXIES: "127.0.0.1, ::1",
    },
  },
);
const stop = () => child.kill("SIGTERM");
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
try {
  process.exitCode = await child.exited;
} finally {
  await rm(manifest, { force: true });
  await rm(temporary, { recursive: true, force: true });
}
