import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
    const port = 42_000 + Math.floor(Math.random() * 1000);
    const origin = `http://localhost:${port}`;
    const child = Bun.spawn(
      [
        "unshare",
        "--user",
        "--map-root-user",
        "sh",
        "-c",
        'echo 8 > /proc/sys/user/max_inotify_watches && exec "$0" "$@"',
        process.execPath,
        fileURLToPath(new URL("./start.ts", import.meta.url)),
      ],
      {
        cwd: workspace,
        env: {
          PATH: process.env.PATH ?? "",
          NODE_ENV: "development",
          NIMBUS_VITE_ORIGIN: "http://127.0.0.1:9",
          PORT: String(port),
          BETTER_AUTH_URL: origin,
          BETTER_AUTH_SECRET: "watch-limit-secret-watch-limit-secret-0123",
          NIMBUS_DATA_ROOT: path.join(workspace, "data"),
          NIMBUS_CONFIG_ROOT: path.join(workspace, "config"),
          NIMBUS_WATCH_DEBOUNCE_MS: "50",
          // Far off, so a change found in time was not found by a pass.
          NIMBUS_RECONCILE_INTERVAL_MS: "600000",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    let output = "";
    const decoder = new TextDecoder();
    const read = async (stream: ReadableStream<Uint8Array>) => {
      for await (const chunk of stream)
        output += decoder.decode(chunk, { stream: true });
    };
    void read(child.stdout);
    void read(child.stderr);
    const until = async (
      check: () => Promise<boolean> | boolean,
      what: string,
    ) => {
      const deadline = Date.now() + 30_000;
      while (!(await check())) {
        if (Date.now() > deadline)
          throw new Error(
            `Timed out waiting: ${what}. Server output:\n${output}`,
          );
        await Bun.sleep(100);
      }
    };
    try {
      await until(
        () =>
          (output.includes("Nimbus is ready") && output.includes("indexed")) ||
          child.exitCode !== null,
        "the server to report ready and indexed",
      );
      expect(child.exitCode).toBeNull();
      await until(
        () => output.includes("fs.inotify.max_user_watches"),
        "the watch limit logged",
      );
      expect((await fetch(`${origin}/api/health`)).status).toBe(200);

      const signup = await fetch(`${origin}/api/auth/sign-up/email`, {
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
      const created = await fetch(`${origin}/api/trpc/files.createFolder`, {
        method: "POST",
        headers,
        body: JSON.stringify({ name: "made-by-nimbus" }),
      });
      expect(created.status).toBe(200);
      await until(async () => {
        const response = await fetch(
          `${origin}/api/trpc/catalog.search?input=${encodeURIComponent(JSON.stringify({ query: "made-by-nimbus" }))}`,
          { headers },
        );
        return (await response.text()).includes('"made-by-nimbus"');
      }, "search to find the folder Nimbus made");

      expect(child.exitCode).toBeNull();
      expect(
        output
          .split("\n")
          .filter((line) => line.includes("fs.inotify.max_user_watches")),
      ).toHaveLength(1);
      expect(output).not.toMatch(/\n\s+at /);
    } finally {
      child.kill("SIGTERM");
      await child.exited;
    }
  },
  60_000,
);
