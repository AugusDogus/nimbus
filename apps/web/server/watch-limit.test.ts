import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ServerChild } from "./server-child-testing";

/**
 * The real server where the inotify watch limit is lower than the drive's folder count. Its
 * user namespace has its own limit, set low, so the kernel refuses watches as a full host
 * would. Unprivileged user namespaces are needed; elsewhere the test is skipped with why.
 */
function namespacesUnavailable() {
  const probe = Bun.spawnSync(
    [
      "unshare",
      "--user",
      "--map-root-user",
      "sh",
      "-c",
      "echo 8 > /proc/sys/user/max_inotify_watches",
    ],
    { stdout: "ignore", stderr: "pipe" },
  );
  return probe.exitCode === 0
    ? null
    : `a user namespace with its own inotify watch limit cannot be made here: ${probe.stderr.toString().trim() || `unshare exited with ${probe.exitCode}`}`;
}
let unavailable: string | null;
try {
  unavailable = namespacesUnavailable();
} catch {
  unavailable = "the unshare tool is not installed";
}
if (unavailable !== null)
  console.warn(`Skipping the inotify watch limit test: ${unavailable}.`);

const scratch = existsSync("/var/tmp") ? "/var/tmp" : os.tmpdir();
let workspace: string;

beforeAll(async () => {
  workspace = await mkdtemp(path.join(scratch, "nimbus-watch-limit-"));
  for (let index = 0; index < 40; index++)
    await mkdir(path.join(workspace, "data", `folder-${index}`, "inner"), {
      recursive: true,
    });
  await mkdir(path.join(workspace, "config"));
});
afterAll(async () => {
  await rm(workspace, { recursive: true, force: true });
});

test.skipIf(unavailable !== null)(
  `at the inotify watch limit the server logs it once, keeps serving, and its own changes still reach search${unavailable === null ? "" : ` (skipped: ${unavailable})`}`,
  async () => {
    // Not the address it listens on: requests name it as the page's origin.
    const origin = "http://nimbus.example.test";
    await ServerChild.run(
      {
        cwd: workspace,
        wrap: [
          "unshare",
          "--user",
          "--map-root-user",
          "sh",
          "-c",
          'echo 8 > /proc/sys/user/max_inotify_watches && exec "$0" "$@"',
        ],
        env: {
          PATH: process.env.PATH ?? "",
          NODE_ENV: "development",
          NIMBUS_VITE_ORIGIN: "http://127.0.0.1:9",
          BETTER_AUTH_URL: origin,
          BETTER_AUTH_SECRET: "watch-limit-secret-watch-limit-secret-0123",
          NIMBUS_DATA_ROOT: path.join(workspace, "data"),
          NIMBUS_CONFIG_ROOT: path.join(workspace, "config"),
          NIMBUS_WATCH_DEBOUNCE_MS: "50",
          // Far off, so a change found in time was not found by a pass.
          NIMBUS_RECONCILE_INTERVAL_MS: "600000",
        },
      },
      async (server) => {
        await server.until(
          () => server.output().includes("indexed"),
          "the server to report the drive indexed",
        );
        await server.until(
          () => server.output().includes("fs.inotify.max_user_watches"),
          "the watch limit logged",
        );
        expect((await fetch(`${server.url}/api/health`)).status).toBe(200);

        const signup = await fetch(`${server.url}/api/auth/sign-up/email`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Origin: origin },
          body: JSON.stringify({
            name: "Admin",
            email: "admin@limit.test",
            password: "Watch-limit-42",
          }),
        });
        expect(signup.status).toBe(200);
        const cookie = signup.headers
          .getSetCookie()
          .map((value) => value.split(";")[0])
          .join("; ");
        const headers = {
          Cookie: cookie,
          Origin: origin,
          "Content-Type": "application/json",
        };
        const created = await fetch(
          `${server.url}/api/trpc/files.createFolder`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({ name: "made-by-nimbus" }),
          },
        );
        expect(created.status).toBe(200);
        await server.until(async () => {
          const response = await fetch(
            `${server.url}/api/trpc/catalog.search?input=${encodeURIComponent(JSON.stringify({ query: "made-by-nimbus" }))}`,
            { headers },
          );
          return (await response.text()).includes('"made-by-nimbus"');
        }, "search to find the folder Nimbus made");

        expect(server.running()).toBe(true);
        expect(
          server
            .output()
            .split("\n")
            .filter((line) => line.includes("fs.inotify.max_user_watches")),
        ).toHaveLength(1);
        expect(server.output()).not.toMatch(/\n\s+at /);
      },
    );
  },
  60_000,
);
