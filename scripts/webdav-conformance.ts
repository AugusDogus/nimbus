/**
 * Run the Litmus WebDAV conformance suite against an isolated Nimbus server.
 *
 *   LITMUS_DIR=/path/to/litmus-0.18 bun scripts/webdav-conformance.ts
 *
 * The server starts through scripts/e2e-server.ts on NIMBUS_E2E_PORT (default 3100) with
 * temporary storage. Every Litmus result must match `expected` below: an unexpected failure,
 * skip, or warning and an expected failure that now passes all fail the run, so the baseline
 * stays reviewed. Litmus 0.18 passes completely, so the baseline is empty.
 */
import path from "node:path";

const litmus = process.env.LITMUS_DIR;
if (!litmus) {
  console.error(
    "Set LITMUS_DIR to a built Litmus 0.18 source directory. See README.md, WebDAV section.",
  );
  process.exit(2);
}
const port = process.env.NIMBUS_E2E_PORT ?? "3100";
const origin = `http://localhost:${port}`;
const groups = ["basic", "copymove", "props", "locks", "http"] as const;

/** Known deviations, by "group: test name", each with the reason it is accepted. Keep it empty when possible. */
const expected: Record<string, { status: "FAIL"; reason: string }> = {};

const server = Bun.spawn(["bun", path.join(import.meta.dir, "e2e-server.ts")], {
  env: { ...process.env, NIMBUS_E2E_PORT: port },
  stdout: "ignore",
  stderr: "inherit",
});
const stop = () => server.kill("SIGTERM");
process.on("SIGINT", stop);

async function waitForServer() {
  for (let attempt = 0; attempt < 240; attempt++) {
    try {
      if ((await fetch(`${origin}/api/health`)).ok) return;
    } catch {
      // Not listening yet.
    }
    await Bun.sleep(500);
  }
  throw new Error(
    `Nimbus did not become healthy at ${origin}/api/health within two minutes.`,
  );
}

async function appPassword() {
  const email = "litmus@nimbus.test";
  const signup = await fetch(`${origin}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({
      name: "Litmus",
      email,
      password: "Litmus-conformance-42",
    }),
  });
  if (!signup.ok)
    throw new Error(
      `Creating the test account failed: ${signup.status} ${await signup.text()}`,
    );
  const cookie = signup.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  const created = await fetch(`${origin}/api/trpc/appPasswords.create`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: origin,
      Cookie: cookie,
    },
    body: JSON.stringify({ name: "Litmus" }),
  });
  const text = await created.text();
  const token = /"token":"([A-Za-z0-9_-]+)"/.exec(text)?.[1];
  if (!created.ok || !token)
    throw new Error(
      `Creating the app password failed: ${created.status} ${text}`,
    );
  return { email, token };
}

let failed = false;
try {
  await waitForServer();
  const { email, token } = await appPassword();
  const seen = new Set<string>();
  for (const group of groups) {
    const run = Bun.spawnSync(
      [path.join(litmus, group), "--no-colour", `${origin}/dav/`, email, token],
      {
        cwd: litmus,
        timeout: 60_000,
      },
    );
    const output = run.stdout.toString();
    process.stdout.write(output);
    for (const line of output.split("\n")) {
      // Litmus prints each test name twice on a line, then its result.
      const match = [
        ...line.matchAll(/(\d+)\.\s+(\w+)\.*\s+(pass|FAIL|SKIPPED)/g),
      ].at(-1);
      if (!match?.[1] || !match[2] || !match[3]) continue;
      const key = `${group}: ${match[1]}. ${match[2]}`;
      const status = match[3];
      seen.add(key);
      const allowed = expected[key];
      if (status === "pass" && allowed?.status === "FAIL") {
        console.error(
          `UNEXPECTED PASS ${key}. Remove it from the baseline in scripts/webdav-conformance.ts.`,
        );
        failed = true;
      } else if (status !== "pass" && allowed?.status !== "FAIL") {
        console.error(`UNEXPECTED ${status} ${key}`);
        failed = true;
      }
    }
    if (/warnings? (was|were) issued/.test(output)) {
      console.error(
        `Litmus group ${group} issued warnings. Fix them; warnings are not accepted.`,
      );
      failed = true;
    }
    if (!/tests run: \d+ passed/.test(output)) {
      console.error(
        `Litmus group ${group} did not finish (exit ${run.exitCode}).`,
      );
      failed = true;
    }
  }
  for (const [key, { status }] of Object.entries(expected))
    if (status === "FAIL" && !seen.has(key)) {
      console.error(
        `Baseline entry ${key} did not run. Update the baseline in scripts/webdav-conformance.ts.`,
      );
      failed = true;
    }
} catch (error) {
  console.error(error);
  failed = true;
} finally {
  stop();
  await server.exited;
}
console.log(
  failed
    ? "WebDAV conformance: FAILED"
    : "WebDAV conformance: matches the reviewed baseline",
);
process.exit(failed ? 1 : 0);
