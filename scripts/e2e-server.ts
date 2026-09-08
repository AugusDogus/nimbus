import { randomBytes } from "node:crypto";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const temporary = await mkdtemp(path.join(os.tmpdir(), "nimbus-e2e-"));
const app = path.resolve(import.meta.dir, "../apps/web");
const data = path.join(temporary, "data");
await mkdir(data);
await cp(path.join(app, "e2e/fixtures/data-root"), data, { recursive: true });
const manifest = path.join(os.tmpdir(), "nimbus-e2e-3100.json");
await writeFile(manifest, JSON.stringify({ dataRoot: data }));
const child = Bun.spawn(["bun", "server/start.ts"], {
  cwd: app, stdout: "inherit", stderr: "inherit",
  env: { ...process.env, NODE_ENV: "development", PORT: "3100", BETTER_AUTH_URL: "http://localhost:3100", BETTER_AUTH_TRUSTED_ORIGINS: "http://localhost:3100", BETTER_AUTH_SECRET: randomBytes(32).toString("base64url"), DATABASE_URL: `file:${temporary}/test.sqlite`, NIMBUS_DATA_ROOT: data },
});
const stop = () => child.kill("SIGTERM");
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
try { process.exitCode = await child.exited; }
finally {
  await rm(manifest, { force: true });
  await rm(temporary, { recursive: true, force: true });
}
